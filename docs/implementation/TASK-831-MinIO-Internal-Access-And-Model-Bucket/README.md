# TASK-831 — Internalize every MinIO reference, and lay out the model bucket

| | |
|---|---|
| **Status** | Review — app-repo changes implemented and verified; deployment-repo changes authored as handover; cluster changes require an operator |
| **Type** | infrastructure / security |
| **Branch** | `worktree-agent-a2f95e6a50de1f5e8`, based on `dev-2.2` |
| **Source** | TASK-828 §4b (problem statement), TASK-823 §8–9 (the proven MinIO access path) |
| **Second repo** | `hope-v2-deployment@main` — read-only here; changes authored in `./deployment/` for the orchestrator to commit |

> ### ⚠️ Ticket number
> The brief assigned **TASK-830**, but `docs/implementation/TASK-830-Nlp-Guard-Classify-Confidences/`
> already exists and is unrelated (it is merged on `dev-2.2` as of `d6cd6a57b`).
> Renumbered to **TASK-831**, the next free number. If the orchestrator's ledger
> says otherwise, this directory is the thing to rename — nothing references the
> number programmatically.

---

## 1. Requirement

The owner, verbatim:

> *"For k8s cluster deployment, ensure all MinIO references must be internal access. Review template and ingest, networking, configurations to set it properly. Internal services should not utilize any public domain names, same as GitLab integrating with MinIO."*
>
> *"Update the MinIO initialization script for creating a model bucket where internal services can access, ensure best practices of blob alignment in the bucket."*

The second sentence of the first quote turns out to be the key to the whole
ticket: **GitLab already does this correctly, and it is the reference
implementation.** See §4.

## 2. Current state — the three things that are actually wrong

### 2.1 Every PHI object operation leaves the cluster

`hope-secrets.MINIO_ENDPOINT = s3.taphuynh.dev`, a proxied Cloudflare Tunnel
hostname with no Cloudflare Access application (TASK-828 §4). There is no MinIO
`Service`, `Endpoints` or `Pod` anywhere in the cluster — MinIO is a standalone
LAN host at `10.10.1.102`. So every consultation recording, generated document
and claim-check payload goes pod → internet → Cloudflare edge → tunnel → a
machine on the k3s node's own `/24`, and back.

Measured from `hope-text` (TASK-823 Phase 2, n=7 median): **495.6 ms via the
tunnel vs 2.0 ms over the LAN — ~248×.**

### 2.2 NEW — `hope-stt` sends PHI audio over plaintext HTTP, across the internet

Not previously recorded. Read from the **live** Deployment, 2026-08-30:

```
MINIO_ENDPOINT  <- secretKeyRef hope-secrets/MINIO_ENDPOINT   # = s3.taphuynh.dev
MINIO_SECURE    = "false"
```

The MinIO Python SDK composes scheme from `secure`, so `hope-stt` builds
**`http://s3.taphuynh.dev`** and speaks **plaintext on port 80 to a public
hostname**. The zone has `always_use_https: off` and `ssl: flexible`
(TASK-828 §5), so the edge serves plaintext rather than redirecting.

This sharpens TASK-828 §5, which concluded "this is **not** PHI in the clear
over the internet today." That conclusion holds only for clients that speak
HTTPS to the tunnel. `hope-stt` — which carries consultation audio, the most
sensitive object class on the platform — does not. **`hope-stt` is the
counter-example to §5, and it is live.**

The same posture is why `hope-stt` once crash-looped: `initialize_minio()` →
`ensure_bucket()` (`apps/stt/src/stt/core/storage/minio_client.py`) runs at
startup with no retry, so a transient failure to resolve the *public* hostname
killed the pod. On the LAN that dependency is a 2 ms hop on the same switch.

### 2.3 The local-dev bootstrap creates NO buckets at all

**A live bug, found while doing the work, in the exact script the second half of
the ticket asks me to update.** `infrastructure/docker/docker-compose.yml`'s
`minio-setup` entrypoint was a YAML **folded** scalar (`>`), which joins every
line into one. Two consequences compound:

1. **Comment folding.** The first `#` comment turns the entire remainder of the
   script into a shell comment.
   - 2026-08-23 (`65739bddc`, TASK-789) put a comment above
     `mc mb minio/harness-claim-check` — that bucket was never created. The
     comment itself warns that a missing bucket "fails SILENTLY". The fix
     disabled its own fix.
   - 2026-08-30 (`9e6bd2d32`, TASK-822) moved a comment above
     `mc mb minio/mlflow`, so from that commit **no bucket was created on any
     developer machine.**
2. **An unescaped `"`.** That same TASK-789 comment contains
   `"The specified bucket does not exist"`. The whole script is one
   double-quoted argument to `/bin/sh -c`, so the literal quote **closed the
   argument early** and the trailing words became stray `argv`.

Proven at the Compose layer, not inferred — see §7 Evidence.

## 3. Reference audit

Both repos. Full raw inventories were produced by two audit passes; this is the
decision table. **Class** is what the reference *is today*; **Must become** is
the target.

### 3.A Cluster runtime — PHI and weights in flight (the ones that matter)

| Ref | Current value | Class | Must become |
|---|---|---|---|
| `hope-secrets.MINIO_ENDPOINT` (live Secret) | `s3.taphuynh.dev` | **PUBLIC** | Delete the key, or `10.10.1.102:9000`. Nothing should read it after the handover — see handover §0 |
| `base/stt.yaml:99` `MINIO_ENDPOINT` | `secretKeyRef hope-secrets` | **PUBLIC** (via the above) | `configMapKeyRef hope-stt-config`, non-optional |
| `base/stt.yaml:~101` `MINIO_SECURE` | `"false"` | **PLAINTEXT** | `"true"` + `MINIO_CERT_CHECK=true` + CA mount |
| `base/stt-worker.yaml:98-119` | same six vars, duplicated | **PUBLIC / PLAINTEXT** | same as `stt.yaml` |
| `base/api.yaml` + `config/api.env:7` | `MINIO_USE_SSL=true`, endpoint via `envFrom hope-secrets` | **PUBLIC** | add `MINIO_ENDPOINT=10.10.1.102:9000` to `api.env`, non-optional `configMapKeyRef` |
| `base/harness-worker.yaml:163-192` | `HARNESS_CLAIM_CHECK_ENDPOINT_URL` ← `hope-secrets.MINIO_ENDPOINT` | **PUBLIC** | `https://10.10.1.102:9000` from `harness.env`; `_SECURE=true` |
| `base/observability-config.yaml:464,712,788` (Loki, Tempo storage) | `10.10.1.102:9000` | **INTERNAL ✅** | already correct — but connects with TLS verification **disabled**; trust the CA once it exists |
| `base/observability-config.yaml:299` (Prometheus `minio` scrape job) | `10.10.1.102` | **INTERNAL ✅** | no change |
| TASK-823 `deployment/vllm.yaml` (not yet handed over) | `https://10.10.1.102:9000` + `AWS_CA_BUNDLE` | **INTERNAL ✅** | no change — this ticket generalises it |
| TASK-822 `deployment/mlflow.env:19` (not yet handed over) | `http://minio.taphuynh.dev:9000` | **PUBLIC + PLAINTEXT** | `https://10.10.1.102:9000` + CA. Correctable before that handover lands |
| `deployment/secrets.dev.yaml.example:55` | `minio.taphuynh.dev:9000` | **PUBLIC** | `10.10.1.102:9000` (it is the template operators copy) |

### 3.B Control plane — endpoints that live in the DATABASE, not in any manifest

**This is the half a manifest-only audit misses, and it is where the platform's
real endpoint lives.** Changing `hope-secrets` alone does *not* repoint the
gateway.

| Row | Purpose | State today | Must become |
|---|---|---|---|
| `TenantStorageConfig` SYSTEM row (`bucketId = NULL`, id `00000000-0000-0000-0005-000000000001`) | **The** platform object-store endpoint for `apps/api`. `MINIO_ENDPOINT` is only a pre-seed bootstrap fallback that logs a WARN when it is the tier that supplied the value | seeded from `MINIO_ENDPOINT`/`MINIO_USE_SSL` at first boot; **create-only**, so a re-seed will not fix it | `endpoint = https://10.10.1.102:9000`, `forcePathStyle = true`. **A super-admin edit or a direct row update — no redeploy will do it** |
| `AiProviderConnection` `service='model-registry'`, `provider='s3'` (id `87000000-…-e2`) | the model-weights endpoint + credential for STT and harness (TASK-799 replaced `STT_MODEL_S3_*`) | seeded **blank and disabled** on purpose | `baseUrl = https://10.10.1.102:9000`, `extraJson.accessKeyId` = the `hope-models-reader` key, encrypted secret = its secret, `enabled = true` |
| Vault kv-v2 `platform/storage/minio` | platform storage credential referenced by `credentialsRef` | operator-managed | unchanged (credential, not endpoint) |

### 3.C Local dev and test — correct as-is, no public hostname anywhere

| Ref | Value | Class |
|---|---|---|
| `infrastructure/docker/docker-compose.yml:139` | `http://minio:9000` (compose service alias) | INTERNAL ✅ |
| `docker-compose.dev.yml:500,509` | `AWS_ENDPOINT_URL` / `RUNAI_STREAMER_S3_ENDPOINT` default `http://minio:9000` | INTERNAL ✅ |
| `docker-compose.dev.yml:742` | `MLFLOW_S3_ENDPOINT_URL: http://minio:9000` | INTERNAL ✅ |
| `tests/docker-compose.test.yml:148` | `http://minio-test:9000` | INTERNAL ✅ |
| `.env.sample:704 / :1931`, `apps/*/.env.sample`, `apps/*/.env.prod` | blank or `localhost:9000` / `localhost:9002` | INTERNAL ✅ (placeholders only) |
| `turbo.json#globalEnv` 404-412, 243-251, 520-521, 587 | 9 `MINIO_*`, 9 `HARNESS_CLAIM_CHECK_*`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `STT_MODEL_S3_SECURE` | N/A — declarations, no values |

**No app-repo source file hardcodes a public MinIO hostname.** Every occurrence
of `s3.taphuynh.dev` in this repo is documentation, research notes, or an
incident report. The public hostname enters the running system through exactly
one door: `hope-secrets`, plus the DB rows in §3.B.

### 3.D The four MinIO hostnames in circulation — drift worth closing

| Hostname | Where | Live? |
|---|---|---|
| `s3.taphuynh.dev` | `hope-secrets`, tunnel ingress 8 | **yes** — the one in use |
| `s3-console.taphuynh.dev` | tunnel ingress 9 → `:9001` | yes (console) |
| `minio.taphuynh.dev` | `secrets.dev.yaml.example:55`, TASK-822 `mlflow.env:19` | **unverified** — appears in templates, not in the tunnel route table |
| `minio-hope.taphuynh.dev` | still pointed at the `hope-docker` tunnel, **down since 2026-03-17** (TASK-828 §7) | dead |

Four names for one host, two of them in files an operator copies from, is its
own hazard. Once §5 lands, the right question is whether the `s3` tunnel routes
need to be public at all — removing them closes the exposure rather than
authenticating it.

## 4. GitLab verdict — it is already correct, and it is the model to copy

The owner's *"same as GitLab integrating with MinIO"* is not an aspiration. It
is a pointer at a working reference implementation.

`docs/research/configs/gitlab/gitlab.rb` (a copy of the GitLab host's Omnibus
config, committed to this repo):

| Setting | Value | What it buys |
|---|---|---|
| `gitlab_rails['object_store']['connection']['endpoint']` | `https://10.10.1.102:9000` | **LAN, not a public hostname** |
| `registry['storage']['s3']['regionendpoint']` | `https://10.10.1.102:9000` | same, for the container registry |
| `...['path_style'] = true` / `'pathstyle' => true` | path-style addressing | required against a MinIO addressed by IP |
| **`object_store['proxy_download'] = true`** | GitLab streams objects **through itself** | **this is the load-bearing one** — see below |
| **`registry['redirect']['disable'] = true`** | registry serves blobs itself | same, for the registry |
| `registry['env'] = { 'SSL_CERT_DIR' => '/etc/ssl/certs' }` | trusts the private CA from the system store | the CA-distribution half |

**Does the LAN path apply to GitLab? Yes — and GitLab already uses it.** GitLab
runs on a VM on the same `10.10.1.0/24` as MinIO, so it is an internal consumer
in exactly the sense the owner means.

**The transferable lesson is `proxy_download`.** The usual objection to a
LAN-only object-store endpoint is presigned URLs: if the server hands a browser
a URL built from `10.10.1.102:9000`, the browser cannot reach it. GitLab
sidesteps that entirely by proxying object downloads through itself, so the
storage endpoint never has to be reachable by a client. That is what makes a
LAN-only endpoint viable rather than a half-measure. **HOPE must make the same
choice explicitly**: either proxy object access through `hope-api`, or accept a
two-endpoint split (internal for server-side I/O, public for browser-facing
presigned URLs) as the Langfuse config in `docs/research/configs/langfuse/`
already does. Silently issuing presigned LAN URLs to a browser fails in a way
that looks like a storage outage.

### What I could NOT verify

- **That the committed `gitlab.rb` matches the live host.** It sits in
  `docs/research/configs/` as a reference copy. I have no shell on the GitLab
  VM and the GitLab API does not expose object-storage configuration, so I
  cannot confirm the running config. Treat §4 as "the documented configuration
  is correct", not "the running configuration is confirmed correct."
- **Whether `minio.taphuynh.dev` resolves at all** — it is in templates but not
  in the tunnel route table read by TASK-823.

### ⚠️ Two security findings surfaced while verifying GitLab

1. **Real MinIO credentials are committed in plaintext** at
   `docs/research/configs/gitlab/gitlab.rb:241-242` and `:269-270` — an access
   key and secret key, in the `object_store` connection block and again in the
   `registry['storage']` block. They are not placeholders. **Not reproduced
   here.** They need rotating, and the rotation has to reach GitLab's own
   config, the buckets' policies, and any `mc` alias built from them.
2. **`.gitleaks.toml` does not catch them.** The `hope-s3-credentials` rule is
   `(...|AWS_ACCESS_KEY_ID|...)\s*[:=]\s*["']?[A-Za-z0-9+/=]{16,}`. Ruby
   hash-rocket form — `'aws_access_key_id' => '…'` — puts a closing quote
   between the name and the `=`, so `\s*[:=]` never matches. A full-tree scan
   returns **"no leaks found"** on that file (§7). The rule needs
   `["']?\s*(=>|[:=])\s*` to cover it.

Both are outside this ticket's write boundary (rotation is an owner action; the
gitleaks rule belongs to whoever owns secret hygiene). Recorded here because
this is where they were found.

## 5. What was implemented

### 5.1 App repo (done, verified)

| File | Change |
|---|---|
| `infrastructure/docker/docker-compose.yml` | `entrypoint: >` → `\|` (fixes the comment-folding bug); the stray `"` in the TASK-789 comment replaced with `'`; `hope-models` created **with object lock**, with an explicit probe + loud warning on a pre-existing lockless bucket; two least-privilege identities provisioned; `./minio/policies:/policies:ro` mounted |
| `infrastructure/docker/minio/policies/hope-models-reader.json` | new — `ListBucket` + `GetObject` on `hope-models` only |
| `infrastructure/docker/minio/policies/hope-models-publisher.json` | new — the above plus `PutObject`, multipart, `PutObjectRetention`. **Neither grants `DeleteObject`** |
| `infrastructure/docker/minio/README.md` | new — endpoint policy, CA distribution, bucket-per-purpose table, the versioning/erasure tension, and the full `hope-models` blob layout + `manifest.json` schema |

### 5.2 Deployment repo (authored, NOT committed)

`./deployment/README.md` and `./deployment/networkpolicy-minio-egress.yaml`.
The orchestrator commits these to `hope-v2-deployment` (EXECUTION-PLAN §14.5).

The design decision worth restating here: **the endpoint moves out of
`hope-secrets` and into the per-service ConfigMap as a non-optional
`configMapKeyRef`.** An endpoint is not a secret; a stale Secret value fails
*open* onto the public tunnel; and a ConfigMap reference is the one form CI can
actually verify (`config-refs` is a blocking gate). A missing key becomes
`CreateContainerConfigError` — the pod refuses to start rather than quietly
reaching for the tunnel.

### 5.3 Networking

`./deployment/networkpolicy-minio-egress.yaml`. An egress policy became
writable for the first time only because the destination collapsed from
"Cloudflare's edge ranges" to a single `/32`.

It ships one fully-derived policy (`hope-stt`, enumerated from the live
Deployment's complete env block) plus templates, and a header that says plainly
why it must not be applied as a batch: **`policyTypes: [Egress]` flips the
selected pods to deny-all-egress.** It is not additive. `hope-v2-dev` has ~43
pods that have never run under any policy, and `hope-api`'s complete egress set
was not enumerated in this session — deriving it is a prerequisite, not a
formality.

Convention followed from TASK-823's `hope-vllm-*`: per-workload, never a
namespace default-deny, DNS rule first, and — for any *ingress* policy added
later — always the Prometheus allow rule. Mine are egress-only, so ingress and
the metrics scrape are untouched.

**Correction to the brief:** it states TASK-823 "shipped the repo's first"
NetworkPolicy. It authored one, but it is **not handed over** —
`hope-v2-deployment` contains no `vllm.yaml`, no `vllm` entry in
`base/kustomization.yaml`, and zero NetworkPolicy objects. Whichever handover
lands first establishes the convention; both follow the same one.

## 6. `hope-models` — bucket and blob layout

Full convention, reasoning and `manifest.json` schema:
**`infrastructure/docker/minio/README.md` §5.** Summary:

```
s3://hope-models/<slug>/<version>/
    manifest.json  SHA256SUMS
    <slug>.<QUANT>.gguf          # single-file preferred
    config.json  tokenizer.json  ...
```

| Decision | Reasoning |
|---|---|
| **Flat within the version prefix** | vLLM's `pull_files()`/`list_safetensors()` walk the prefix and expect config, tokenizer and weights side by side. Nesting `model/` breaks it (TASK-823 §8.4) |
| **`<version>` = `<quant>-<sha256-12>` of `manifest.json`** | The manifest lists a digest for every object, so hashing it is a **Merkle root** — one short label pinning the whole tree. Naming the prefix after the weights file alone leaves the tokenizer free to change under a stable URI |
| **Content-addressed at all** | Overwriting a published prefix means running pods keep serving old bytes from page cache while new pods fetch different bytes from an *identical* URI — no error, no version bump, no log line. A content-derived name makes that impossible to express |
| **`v1`/`v2` grandfathered** | `hope-models/qwen3-4b-awq/v1/` is already published (TASK-823). Sequential `vN` still delivers immutability if never rewritten; the content-derived form additionally makes a violation *detectable* |
| **No `llm/` vs `embeddings/` split** | Role is a `manifest.json` field. A prefix split buys nothing a field does not, breaks the published URI, and diverges from `models/{slug}/{revision}/{filename}`, the shape `apps/stt`'s `path_resolver.py` already builds |
| **`primaryObject` in the manifest** | Pointing a llama.cpp-family server at any shard but the first yields `illegal split file idx`; there is no discovery. Recording shard `-00001-of-000NN` explicitly removes the inference |
| **`shardCount` in the manifest** | A partial sync that lands shard 2 first fails **silently** — the prefix looks populated. `shardCount` makes completeness checkable before serving |
| **Versioning + object lock ON** | A published weight prefix must never change under a running pod |
| **Versioning OFF on `mlflow`** | Opposite requirement, same product. `mlflow gc` is MLflow's only hard-delete path and therefore its only right-to-erasure mechanism; with versioning on, `gc` writes a **delete marker** and erasure silently becomes retention (TASK-822 F-4) |
| **Reader SA with no `PutObject`** | Object lock protects bytes already written and versioning makes a mistake recoverable, but **a credential that cannot write is what makes the overwrite impossible in the first place.** Three layers because each covers a different failure: malice, accident, misconfiguration |

The five models: `gemma4-e2b-it-qat`, `gemma4-e4b-it-qat`,
`granite-guardian-4.1-8b`, `qwen3.5-4b` (llm) and
`text-embedding-embeddinggemma-300m-qat` (embeddings).

**Object lock is creation-only.** `mc mb --with-lock` cannot be applied
retroactively, and `mb --ignore-existing --with-lock` against an existing bucket
does nothing and exits 0. The bootstrap therefore probes and warns loudly rather
than reporting a success that did not happen — which matters because
`hope-models` already exists on developer machines and (per §8) may already
exist on the cluster host.

## 7. Evidence

### 7.1 The compose bug, proven at the Compose layer

`docker compose config` renders `entrypoint` as argv. **It must be 3 elements**
(`/bin/sh`, `-c`, script).

```
$ docker compose -f /tmp/orig-compose.yml config --format json minio-setup   # HEAD, before the fix
ORIGINAL (HEAD) entrypoint argv length: 9
  0 '/bin/sh'
  1 '-c'
  2 " echo 'Setting up MinIO buckets and policies...'; until /usr/bin/mc al"
  3 'specified'
  4 'bucket'
  5 'does'
  6 '#'
  7 'not'
  8 'exist — and because dispatch is best-effort, it fails SILENTLY. /usr/b'
```

Everything from the first `#` onward is a shell comment inside argv[2]; the
words after the stray `"` became separate arguments. After the fix:

```
$ docker compose -p task831verify -f docker-compose.yml config --format json minio-setup
ENTRYPOINT ARGV LENGTH (must be 3): 3
argv[0..1]: ['/bin/sh', '-c']
volumes: ['…/infrastructure/docker/minio/policies:/policies']
$ sh -n /tmp/minio-setup.sh && echo OK
SHELL SYNTAX OK
```

### 7.2 Bootstrap run — isolated compose project, dev stack untouched

```
$ docker compose -p task831verify -f docker-compose.yml -f <scratch>/task831-verify.override.yml \
    up minio-setup --abort-on-container-exit
Setting up MinIO buckets and policies...
Added `minio` successfully.
MinIO is ready, creating buckets...
Bucket created successfully `minio/mlflow`.
Bucket created successfully `minio/hope-models`.
  hope-models: created with versioning + object lock
minio/hope-models versioning is enabled
Bucket created successfully `minio/recordings`.
Bucket created successfully `minio/generated-audio`.
Bucket created successfully `minio/documents`.
Bucket created successfully `minio/backups`.
Bucket created successfully `minio/harness-claim-check`.
Setting bucket policies...
mc: Please use 'mc anonymous'
mc: Please use 'mc anonymous'
Configuring at-rest SSE (TASK-369 Phase 1)...
Provisioning least-privilege hope-models identities (TASK-831)...
Created policy `hope-models-reader` successfully.
Created policy `hope-models-publisher` successfully.
Added user `hope-models-reader` successfully.
Added user `hope-models-publisher` successfully.
Blob layout for hope-models: <slug>/<version>/{manifest.json,SHA256SUMS,*.gguf,...}
  version is content-addressed; a published prefix is NEVER overwritten.
  Convention + manifest.json schema: infrastructure/docker/minio/README.md
MinIO setup completed successfully
task831-verify-minio-setup exited with code 0
```

Second run (idempotency + the object-lock probe taking its other branch):

```
  hope-models: present, object lock ON
minio/hope-models versioning is enabled
…
MinIO setup completed successfully
```

### 7.3 Least-privilege enforcement — all six assertions

Run against the isolated MinIO with the two provisioned identities:

```
--- [1] publisher CAN write to hope-models (expect OK) ---
`/tmp/model.gguf` -> `pub/hope-models/demo-slug/q4-abc123/model.gguf`   [8 B transferred]
--- [2] reader CAN read (expect OK) ---
weights
--- [3] reader CANNOT overwrite a published prefix (expect DENIED) ---
mc: <ERROR> Failed to copy … Insufficient permissions to access this path
--- [4] reader CANNOT delete (expect DENIED) ---
mc: <ERROR> Failed to remove … Access Denied.
--- [5] reader CANNOT touch the PHI bucket at all (expect DENIED) ---
mc: <ERROR> Unable to list folder. Access Denied.
--- [6] publisher CANNOT delete either (expect DENIED) ---
mc: <ERROR> Failed to remove … Access Denied.
```

### 7.4 Teardown — no residue, dev stack unharmed

```
$ docker compose -p task831verify … down -v
 Volume hope-postgres-data-pg18 Removing
 Volume hope-postgres-data-pg18 Resource is still in use
 Network task831-verify-net Removed
=== leftovers (must be empty) ===
=== dev stack untouched ===
hope-minio Up 2 days (healthy)
```

> ⚠️ **Note that `Volume hope-postgres-data-pg18 Resource is still in use` line.**
> `docker-compose.yml` gives its named volume a fixed `name:`, so it is shared
> across compose *projects*. A `down -v` on an isolated project therefore tries
> to delete the developer's Postgres data volume, and only failed here because
> the dev stack had it open. **Never run `down -v` on a compose project built
> from this file while the dev stack is stopped.**

### 7.5 gitleaks

```
$ gitleaks detect --source . --no-git --config .gitleaks.toml --redact
INF scanned ~75612105 bytes (75.61 MB) in 10.6s
INF no leaks found
```

And the detection gap from §4:

```
$ gitleaks detect --source docs/research/configs/gitlab --no-git --config .gitleaks.toml --redact -v
INF no leaks found          # …on a file containing a real access key and secret key
```

## 8. Operator procedure — the external cluster MinIO

**The cluster MinIO is bootstrapped by nothing.** It is a standalone host with
no `Service`, no `Pod`, and no manifest in either repo. Every step below is a
human action on `10.10.1.102`; none of it is GitOps, and Argo cannot do any of
it. Editing `docker-compose.yml` does **not** change the cluster — the two init
paths are independent and must be kept in step by hand.

```bash
# ── 0. Trust the CA. mc reads SSL_CERT_FILE; certs/CAs/ does NOT work (tested).
export SSL_CERT_FILE=/path/to/arcaai-ca.crt
export MC_HOST_hope="https://<root-access-key>:<root-secret>@10.10.1.102:9000"
mc admin info hope        # must succeed before continuing

# ── 1. hope-models, WITH OBJECT LOCK.
#      Lock is creation-only. If the bucket already exists WITHOUT lock, `mb`
#      here silently does nothing. Check first, and decide deliberately —
#      recreating means re-uploading every weight.
mc ls hope/hope-models >/dev/null 2>&1 \
  && mc retention info --default hope/hope-models \
  || mc mb --with-lock hope/hope-models
mc version enable hope/hope-models

# ── 2. Least-privilege identities. Copy the two policy documents from
#      infrastructure/docker/minio/policies/ in the app repo.
mc admin policy create hope hope-models-reader    ./hope-models-reader.json
mc admin policy create hope hope-models-publisher ./hope-models-publisher.json
mc admin user add hope <models-reader-key> <models-reader-secret>
mc admin user add hope <models-publisher-key> <models-publisher-secret>
mc admin policy attach hope hope-models-reader    --user <models-reader-key>
mc admin policy attach hope hope-models-publisher --user <models-publisher-key>

# ── 3. Pre-create the STT buckets rather than letting the app do it.
#      apps/stt creates hope-audio / hope-audio-chunks at RUNTIME via
#      ensure_bucket(), which forces the app credential to hold CreateBucket
#      and makes a startup failure look like a storage outage.
mc mb --ignore-existing hope/hope-audio
mc mb --ignore-existing hope/hope-audio-chunks

# ── 4. Publish weights. Procedure + manifest schema:
#      infrastructure/docker/minio/README.md §5.5. Never overwrite a prefix.
```

Then, **not on the MinIO host** — the two control-plane rows from §3.B, which no
manifest change can reach:

```
# 5. TenantStorageConfig, SYSTEM tenant, bucketId = NULL
#    (id 00000000-0000-0000-0005-000000000001)
#      endpoint       -> https://10.10.1.102:9000
#      forcePathStyle -> true
#    Super-admin console, or a direct row update. The seed is CREATE-ONLY, so
#    re-seeding will NOT correct an existing row.

# 6. AiProviderConnection, service='model-registry', provider='s3'
#    (id 87000000-0000-0000-0000-0000000000e2) — seeded blank + disabled
#      baseUrl                -> https://10.10.1.102:9000
#      extraJson.accessKeyId  -> <models-reader-key>
#      encrypted key          -> <models-reader-secret>
#      enabled                -> true
```

And finally verify from inside the cluster, from a pod that actually stores
objects:

```bash
kubectl -n hope-v2-dev exec deploy/hope-stt -- \
  python -c "import socket,time; s=time.time(); \
  socket.create_connection(('10.10.1.102',9000),5).close(); print(time.time()-s)"
# expect ~0.002s. If it is ~0.5s you are still on the tunnel.
```

## 9. ROOT_CONFIG_REQUESTs

| # | Request | Blocking? |
|---|---|---|
| **R-1** | **Publish the `ARCAAI Internal CA` as ConfigMap `arcaai-internal-ca` (key `ca.crt`) in `hope-v2-dev`.** It does not exist; the namespace has no CA material at all. MinIO serves a one-certificate chain so the issuer cannot be scraped off the wire — the PEM must come from wherever it was generated (likely the MinIO host). **TASK-823 §9.1 already raised this, but its priority changes here**: for TASK-823 it blocked one workload at `replicas: 0`; after this ticket it blocks `hope-api`, `hope-stt` and `hope-harness`. Expires **2028-03-21** | **YES — platform-wide** |
| **R-2** | Set the two control-plane rows (§8 steps 5–6). No redeploy reaches them | **YES** |
| **R-3** | Mint the `hope-models` reader/publisher keys on the cluster MinIO (§8 step 2) and add `MINIO_MODELS_ACCESS_KEY`/`_SECRET_KEY` to `hope-secrets` | YES for weights |
| **R-4** | Correct or delete `hope-secrets.MINIO_ENDPOINT` (still `s3.taphuynh.dev`) | No — handover §0 makes correctness independent of it, but leaving it is a trap |
| **R-5** | **Rotate the MinIO credentials committed at `docs/research/configs/gitlab/gitlab.rb:241-242,269-270`**, and fix the `hope-s3-credentials` gitleaks regex to match Ruby hash-rocket form (§4) | Owner action |
| **R-6** | Decide the presigned-URL posture (§4): proxy object access through `hope-api` as GitLab does, or adopt an explicit two-endpoint split. Silently issuing LAN presigned URLs to browsers fails like a storage outage | Design decision |

## 10. Findings recorded, not fixed

| # | Finding |
|---|---|
| F-1 | `mc policy set public` is **deprecated and a no-op** — it prints `mc: Please use 'mc anonymous'` and exits 0 (§7.2). `recordings` and `generated-audio` have therefore **not** been public for some time, on any machine running a recent `mc`. The line reads as working and does nothing. Left alone deliberately: `recordings` holds PHI, and *restoring* anonymous read is not a change I would make silently. Someone should decide whether that policy was ever wanted |
| F-2 | `tests/docker-compose.test.yml:152-156` creates `mlflow`, `recordings`, `generated-audio`, `documents`, `backups` — but **not `hope-models` or `harness-claim-check`**. Any integration test touching those against the real test MinIO fails on a missing bucket. Its entrypoint is also a folded `>` scalar; it works today only because it happens to contain no `#` comment and no `"`. It is one comment away from the §2.3 bug |
| F-3 | `hope-audio` / `hope-audio-chunks` are created at **runtime** by `ensure_bucket()` in `apps/stt/.../minio_client.py`, not by any init script. That forces the app credential to hold `CreateBucket` — the opposite of least privilege — and turns a storage hiccup into a startup crash-loop (no retry). §8 step 3 pre-creates them; narrowing the credential is a follow-up |
| F-4 | `hope-secrets` still carries `kubectl.kubernetes.io/last-applied-configuration` with the entire `stringData` block in cleartext. Confirmed present 2026-08-30. Rotating without stripping the annotation does not retire the old values. Already recorded in TASK-823 §8.6 / TASK-828; repeated because every credential action in §8 is undermined by it |
| F-5 | Loki and Tempo reach `10.10.1.102:9000` with TLS **verification disabled**. Endpoint-correct, trust-incorrect. Fix once R-1 lands |
| F-6 | `docker-compose.yml`'s named volume has a fixed `name:`, so it is shared across compose projects and a `down -v` on any project built from this file targets the developer's Postgres volume (§7.4) |

## 11. Change History

| Date | Change |
|---|---|
| 2026-08-30 | Created. Audited both repos; fixed the local-dev bootstrap (folded-scalar + stray-quote bugs that had disabled all bucket creation since 2026-08-23/08-30); added object lock, least-privilege identities and the content-addressed blob layout to `hope-models`; authored the deployment-repo handover and the first egress NetworkPolicy draft. Recorded the `hope-stt` plaintext-PHI path (new, sharpens TASK-828 §5), the GitLab reference implementation, committed GitLab MinIO credentials with the gitleaks rule gap that hides them, and six secondary findings. |
