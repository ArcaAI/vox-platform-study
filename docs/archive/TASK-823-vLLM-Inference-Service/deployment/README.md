# TASK-823 — manifests for `hope-v2-deployment` (HANDOVER, not applied)

These files are **authored here and committed by the orchestrator**, per
EXECUTION-PLAN §14.5: three tickets (822, 823, 824) each add a workload, and all
three append to the same `base/kustomization.yaml` and the same dev `images:`
stanza, so one writer applies them in ticket order.

**Nothing here has been applied to the cluster, and nothing has been committed to
`hope-v2-deployment`.**

> **Read `../README.md` §2A before deploying anything.** The Deployment ships at
> `replicas: 0` because the sizing arithmetic says no useful model fits on this
> node's 2× 16 GiB cards at the ticket's concurrency target. That is a
> deliberate verdict, not an unfinished manifest.

---

## 1. Files to copy

| From (this directory) | To (`hope-v2-deployment`) |
|---|---|
| `vllm.yaml` | `deployment/k8s/base/vllm.yaml` |
| `config/vllm.env` | `deployment/k8s/base/config/vllm.env` |

`vllm.yaml` contains, `---`-separated: Deployment · ConfigMap (the nginx
allow-list) · Service · HPA · PDB · NetworkPolicy.

## 2. `base/kustomization.yaml` — two additions

Add to `resources:` (§14.4 point 1 requires a comment saying why), placed after
`nlp.yaml` so the AI-service block stays contiguous:

```yaml
  # vLLM self-hosted inference (TASK-823). Ships at `replicas: 0`: this node's
  # 2x RTX 2000 Ada (16380 MiB each) cannot hold an 8B-class model plus a
  # useful KV cache, and time-slicing gives no VRAM isolation to make sharing a
  # card safe — see the header of vllm.yaml. Present so the security posture,
  # the first NetworkPolicy in this repo and the MinIO weight path are
  # reviewable and version-controlled, and so enabling it is a one-line change
  # the day the hardware exists.
  - vllm.yaml
```

Add to `configMapGenerator:` (after `hope-qdrant-config`):

```yaml
  - name: hope-vllm-config
    envs: [config/vllm.env]
```

> The nginx allow-list is a **plain ConfigMap inside `vllm.yaml`**, deliberately
> *not* a generator entry: a generator's content hash would roll the GPU pod —
> and pay another multi-minute cold start — on any edit to nginx config.

## 3. `overlays/dev/kustomization.yaml` — one patch, no `images:` entry

**No `images:` entry is needed.** That stanza carries CI-built `hope-v2/*`
images with digests written by the `promote-*` jobs. `vllm/vllm-openai` is a
third-party image pinned directly in `base/`, the same way `prom/prometheus`,
`grafana/grafana`, `hashicorp/vault` and `qdrant/qdrant` already are.

Add one patch, in the same block as the existing `hope-stt` / `hope-stt-worker`
surge patches, for the same reason those exist:

```yaml
- patch: |
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: hope-vllm
    spec:
      strategy:
        type: RollingUpdate
        rollingUpdate:
          maxSurge: 0
          maxUnavailable: 1
  target:
    kind: Deployment
    name: hope-vllm
```

Why: a surge pod is a **second full VRAM allocation** and a second
`nvidia.com/gpu` slice on a single node that has neither to spare. Base keeps
the house `maxUnavailable: 0 / maxSurge: 1` so multi-node environments inherit
zero-downtime semantics; dev inverts it exactly as it already does for both STT
workloads. Name-based strategic merge, never an index-based JSON6902 patch —
CI's `patch-hygiene` job bans those outright.

## 4. The egress NetworkPolicy — RESOLVED and now shipped (Phase 2)

`vllm.yaml` ships **both** halves of V-3 now: the ingress policy, and the egress
policy that makes "weights come only from MinIO" *enforced* rather than
aspirational.

This was previously blocked. The only MinIO address the platform knew was
`hope-secrets.MINIO_ENDPOINT = s3.taphuynh.dev`, a **proxied Cloudflare Tunnel
hostname with no Cloudflare Access application** (TASK-828 §4). An egress rule
scoped to "MinIO only" would have had to allow Cloudflare's edge ranges — close
to allowing the open internet, and a control in name only.

**Phase 2 resolved it.** The tunnel's own route table (read from the Cloudflare
API, tunnel `arca-dev`, ingress ids 8–10) says where that hostname actually
lands:

| Public hostname | Origin |
|---|---|
| `s3.taphuynh.dev` | `https://10.10.1.102:9000` (`noTLSVerify: true`) |
| `s3-console.taphuynh.dev` | `https://10.10.1.102:9001` |
| `ssh-minio.taphuynh.dev` | `ssh://10.10.1.102:22` |

MinIO is a **dedicated LAN host, `10.10.1.102`**, on the same `/24` as the k3s
node (`10.10.1.10`). So the egress rule is a single `/32` and the control is
real. It is written out in full at the bottom of `vllm.yaml`.

Why this is the right shape and not a workaround: **`hope-secrets` already
addresses every other out-of-band dependency by raw LAN IP** —
`DATABASE_URL … @10.10.1.250:5000`, `REDIS_HOST=10.10.1.120`,
`TEMPORAL_DB_HOST=10.10.1.250`. MinIO was the *only* one reached through the
public internet. Pointing vLLM at `10.10.1.102` brings it into line with house
convention rather than inventing one.

## 5. `smoke-test.yaml` — do NOT add a check yet

§14.4 point 5 says wire every new workload into the smoke test. **Not while
`replicas: 0`:** the smoke test is an Argo `PostSync` hook, and a failing
PostSync hook marks the whole Application **Degraded**. A check against a
Service with no endpoints fails every sync forever.

Add this line in the same change that raises `replicas` above 0, and not before:

```sh
check vllm              "http://hope-vllm:8000/health"
```

## 6. Verification order after enabling

Do these in order; each one has produced a real outage in this estate or is
guarded against a documented vLLM failure mode.

1. **Measure real free VRAM on the node first** — `nvidia-smi` on `dell`. The
   k8s ledger understates it: LM Studio runs on the node **host**
   (`out-of-band/lmstudio-endpoints.yaml` → `10.10.1.10:1234`) and holds VRAM
   outside scheduler accounting. `base/dashboards/gpu.json` already carries this
   warning.
2. ~~Confirm the image bundles the Run:ai streamer extras.~~ **DONE in Phase 2 —
   it does.** `docker/Dockerfile` at tag `v0.11.0` builds `vllm-openai` FROM
   `vllm-openai-base` (`:540`, `:506`), whose pip layer (`:529`) ends
   `… boto3 runai-model-streamer runai-model-streamer[s3]`. No init-container
   pre-pull fallback is needed. That install is UNPINNED, so re-verify on any
   image bump:
   `docker run --rm --entrypoint python3 vllm/vllm-openai:<tag> -c "import runai_model_streamer"`.
3. **Read the engine's own KV number from the startup log** — vLLM prints the
   computed `GPU KV cache size: N tokens`. Divide by `--max-model-len` for real
   concurrency and compare against `../README.md` §2A. The activation/CUDA-graph
   term is the least precise input to that arithmetic; this is how you replace
   the estimate with a measurement.
4. **Prove the NetworkPolicy is enforced.** k3s ships a NetworkPolicy controller
   with flannel, but `--disable-network-policy` turns it off and the server
   flags are not readable through the API. From any pod that is neither
   `hope-text` nor `prometheus`:
   `curl --max-time 5 http://hope-vllm:8000/health` — it **must time out**. If
   it returns 200 the policy is decorative; say so rather than leaving it in
   place looking like a control.
5. **Prove the allow-list.** From `hope-text`:
   `curl -s -o /dev/null -w '%{http_code}' http://hope-vllm:8000/invocations`
   must be **404**, and the same for `/pause`, `/abort_requests`,
   `/update_weights`, `/collective_rpc`. `/v1/models` must be 200.
6. **Assert V-1 against the running pod** — `VLLM_SERVER_DEV_MODE` must be
   absent from the container env, not merely unset in Git.
7. **Check for PHI in logs** — run a full generation and grep the pod logs for
   prompt text at INFO. Expect none.
8. **Confirm the scrape landed** — `vllm:num_requests_running` present in
   Prometheus. If it is missing, the ingress policy's Prometheus rule is wrong.

## 7. What this manifest set does NOT do

- **No `--api-key`.** It protects only `/v1`, `/v2` and `/inference` — the
  nginx allow-list already restricts the surface further than that, and the
  NetworkPolicy restricts the source. Enabling it also requires a **coupled**
  write to the SYSTEM `AiProviderConnection` row, whose `apiKey` is currently
  the platform's self-host placeholder `not-needed`; done out of order it 401s
  every generation. See `../README.md` §5.
- **No KEDA / `ScaledObject`.** Follows the house precedent (an inert HPA), not
  the upstream one. `vllm:num_requests_waiting` is recorded as the metric to
  scale on when KEDA arrives.
- **No `ServiceMonitor`.** There is no Prometheus Operator; metrics are
  annotation-scraped.
- **No MLflow resolver.** TASK-822 owns it. This manifest consumes its output:
  CI writes a resolved, immutable `s3://` URI into `config/vllm.env`. The pod
  never talks to MLflow.

---

## 8. The MinIO weight path — what Phase 2 actually proved

Phase 1 **specified** this path; Phase 2 **ran** it. Everything below is a
measurement or a source citation, not a plan.

### 8.1 Where MinIO is, and why the endpoint changed

| | Before (Phase 1) | Now |
|---|---|---|
| `VLLM_S3_ENDPOINT_URL` | `https://s3.taphuynh.dev` | `https://10.10.1.102:9000` |
| Path | Pod → Cloudflare edge → tunnel → origin | Pod → LAN |
| Median request (measured, n=7, from `hope-text`) | **495.6 ms** | **2.0 ms** |
| Egress policy expressible? | No (Cloudflare edge ranges) | Yes (`10.10.1.102/32`) |

There is **no MinIO Service, Endpoints, or Pod anywhere in the cluster** —
`kubernetes_list` over Services and Endpoints in every namespace returns none.
MinIO is out-of-band infrastructure, and `hope-secrets` already reaches the
other out-of-band dependencies (Postgres `10.10.1.250:5000`, Redis
`10.10.1.120:6379`) by raw LAN IP. MinIO was the sole exception.

**No new Kubernetes object is required for the endpoint.** The leaf's SAN
carries `IP:10.10.1.102`, so the IP address verifies directly.

<details>
<summary>If you would rather have a stable NAME than an IP</summary>

The leaf's SAN also carries `DNS:minio`, so a Service named exactly `minio` in
`hope-v2-dev` would let you use `https://minio:9000` and verify cleanly.

**It must be applied out of band, never through kustomize.** A selector-less
Service in the kustomize tree gets a selector INVENTED for it by the legacy
`commonLabels:` transformer, the endpoints controller then takes ownership, and
the static address is replaced by every pod in the namespace. That is not
hypothetical — it is what `out-of-band/lmstudio-service.yaml`'s header
documents as having taken out both the summarization and safety paths on
2026-08-09. Argo CD also excludes `Endpoints`/`EndpointSlice` cluster-wide, so
it can neither create nor heal them.

The IP is simpler, needs nothing new, and matches how Postgres and Redis are
already addressed. Prefer it.
</details>

### 8.2 TLS — a private CA, and it is mandatory ⟵ **SUPERSEDED 2026-08-30**

> **The MEASUREMENT below is still true, and still the reason the scheme is
> `https://`. What was overridden is "so mount the CA".**
> The owner directed on 2026-08-30 that the private CA be removed entirely and
> that a service-account credential be the only authentication (§9.1). The
> transport did NOT change — MinIO serves TLS on :9000 and one port serves one
> scheme, so this section's certificate reading remains the operative fact. What
> changed is that **certificate verification is now turned off** instead of
> pointed at a bundle.
>
> ⚠️ For vLLM specifically that is easier said than done — see OPEN-823-TLS in
> `config/vllm.env`: variant 2 of the §10 lab (https + private CA + no
> `AWS_CA_BUNDLE`) is EXACTLY the new configuration, and it FAILED
> `CERTIFICATE_VERIFY_FAILED` on the first LIST, because boto3 has no env var
> that disables verification. Resolution is an owner decision.

Read off the wire from inside `hope-v2-dev` on 2026-08-30:

```
subject  C=AU, ST=Victoria, L=Melbourne, O=ARCAAI, OU=Infrastructure, CN=s3.taphuynh.dev
issuer   C=AU, ST=Victoria, L=Melbourne, O=ARCAAI, OU=Infrastructure, CN=ARCAAI Internal CA
notAfter Mar 21 03:48:21 2028 GMT
SAN      DNS:s3.taphuynh.dev, DNS:s3-console.taphuynh.dev, DNS:localhost,
         DNS:minio, IP:10.10.1.102, IP:127.0.0.1
EC P-256, X509v3 Extended Key Usage: TLS Web Server Authentication
```

- The system trust store does **not** contain this CA — a default-context
  handshake from `hope-text` fails `unable to get local issuer certificate`.
  (The Cloudflare tunnel hides this today by setting `noTLSVerify: true` on the
  origin, and by presenting a *public* edge certificate to its clients. Going
  direct removes both crutches.)
- Therefore **`AWS_CA_BUNDLE` is required**, and `vllm.yaml` mounts it. There is
  deliberately no "skip verification" option: this is a PHI object store.
- **The CA is published nowhere in `hope-v2-dev`.** The namespace has no CA
  ConfigMap or Secret (`kube-root-ca.crt` is the cluster's own CA, unrelated).
  Creating `arcaai-internal-ca` is a ROOT_CONFIG_REQUEST — see §9.

### 8.3 The two settings that are non-negotiable, and why

Both are set in `vllm.yaml`; both were verified against vLLM's own source.

**`RUNAI_STREAMER_S3_ENDPOINT` — set it explicitly, as version insurance.**
Stated carefully, because the obvious reading is wrong: a full 902-tensor stream
**succeeded with this variable unset**, so streamer 0.16.1's AWS C++ SDK reads
`AWS_ENDPOINT_URL` by itself. vLLM does not depend on that — it copies one into
the other (`runai_streamer_loader.py:43-49`), and only *inside*
`if load_config.model_loader_extra_config:`. Since the vLLM image installs the
streamer **unpinned**, setting both makes the config independent of which
streamer version the image carries, and decouples an S3 setting from an
unrelated tuning flag. Applied to the dev compose `inference` profile too, which
does not pass `--model-loader-extra-config`.

**`RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0`** — path-style addressing. Note
that there are **two different S3 clients** in this load path, and only one of
them reads this variable:

| Stage | Client | Reads |
|---|---|---|
| `pull_files()` / `list_safetensors()` — config, tokenizer, shard listing | boto3 (Python) | `AWS_CA_BUNDLE`, `AWS_ENDPOINT_URL` |
| `SafetensorsStreamer.stream_files()` — the weights | Run:ai C++ / AWS C++ SDK | `RUNAI_STREAMER_*` |

So a smoke test that only lists objects will pass with the variable wrong. It
has to stream real weights to exercise the C++ client at all.

### 8.4 The S3 layout vLLM requires

Derived from `vllm/config/model.py:701-728` and
`vllm/transformers_utils/runai_utils.py`:

1. `pull_files(uri, allow_pattern=["*.model","*.py","*.json"])` → config and
   friends, into a temp dir.
2. `pull_files(uri, ignore_pattern=["*.pt","*.safetensors","*.bin","*.tensors","*.pth"])`
   → everything else non-weight (this is the pass that fetches `merges.txt`).
   Runs only when `--tokenizer` is unset, i.e. tokenizer == model.
3. `list_safetensors(uri)` → `*.safetensors`, which are **streamed, never
   downloaded**. No PVC, no `hostPath`, no init container.

A **flat prefix** is therefore correct — do not nest `model/` and
`components/tokenizer/` subdirectories:

```
s3://hope-models/<model-slug>/<version>/
    config.json  generation_config.json
    model.safetensors            <- streamed
    tokenizer.json  tokenizer_config.json  vocab.json  merges.txt
```

**The trailing slash on `VLLM_MODEL_URI` is optional** — tested, not assumed.
With a decoy `.../v10/model.safetensors` deliberately present in the same
bucket, both `.../v1` and `.../v1/` resolved to exactly one shard,
`.../v1/model.safetensors`. `list_safetensors` normalises the prefix; it does
not do a bare string match. Keep the slash for readability if you like, but
nothing depends on it.

### 8.5 Upload procedure

> ⚠️ **AMENDED 2026-08-30.** The `https://10.10.1.102:9000` endpoint below is
> unchanged. Under the owner's no-CA directive, replace `export SSL_CERT_FILE=…`
> with **`mc --insecure`** on every `mc` invocation (the flag is evaluated per
> call, not remembered by the alias). Everything else — checksum-before-upload,
> `SHA256SUMS`, versioned bucket, never overwrite a prefix — is unchanged and
> still mandatory. The `SSL_CERT_FILE` form is retained because it is the
> reinstatement procedure; see §9.1.

`mc` is a Go binary: it honours **`SSL_CERT_FILE`** for a private CA. Dropping
the PEM into `<config-dir>/certs/CAs/` did **not** take effect (tested).

```bash
# 0. Fetch the checkpoint and VERIFY IT AGAINST THE PUBLISHER before it is ever
#    uploaded. HuggingFace publishes the LFS sha256 via the tree API:
#      curl -s 'https://huggingface.co/api/models/Qwen/Qwen3-4B-AWQ/tree/main?recursive=1' \
#        | jq -r '.[] | select(.lfs) | "\(.lfs.oid)  \(.path)"'
#    For Qwen/Qwen3-4B-AWQ, model.safetensors is
#      a7043493ebd993f5fea18794ad7b5b3e064a52023f392a7fcce7ce0984c341f0   (2666027672 bytes)
shasum -a 256 ./qwen3-4b-awq/model.safetensors     # must equal the above

# 1. Record every object's digest. This file is the provenance record, and the
#    model.safetensors line is what becomes the MLflow `weights_sha256` tag
#    that TASK-822 §4A.1 step 3 asserts before promotion.
( cd qwen3-4b-awq && shasum -a 256 ./* | tee SHA256SUMS )

# 2. Point mc at MinIO, trusting the ARCAAI CA.
export SSL_CERT_FILE=/path/to/arcaai-ca.crt
export MC_HOST_hope="https://<access-key>:<secret-key>@10.10.1.102:9000"

# 3. Bucket, versioned. Versioning is what makes a promoted URI immutable, and
#    what makes a bad promotion recoverable without re-uploading.
mc mb --ignore-existing hope/hope-models
mc version enable hope/hope-models

# 4. Upload the flat prefix, asking MinIO to verify each object's SHA256 in
#    flight rather than trusting the transfer.
mc cp --recursive --checksum SHA256 ./qwen3-4b-awq/ hope/hope-models/qwen3-4b-awq/v1/

# 5. Prove what landed.
mc ls --recursive hope/hope-models/qwen3-4b-awq/v1/
```

**Never overwrite a published prefix.** Promotion is a NEW version prefix
(`/v2/`) plus a config change, so rollback is a revert rather than a re-upload.

### 8.6 Credentials

> ⚠️ **CHANGED 2026-08-30.** `vllm.yaml` no longer reuses
> `hope-secrets.MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`. It reads the dedicated
> **`hope-models-reader`** Secret (keys `accessKeyId` / `secretAccessKey`),
> holding a MinIO SERVICE ACCOUNT scoped by the committed `hope-models-reader`
> policy — read-only, `hope-models` only. See §9.1b. The paragraph below records
> what was there before and why it was wrong.

~~No new secret. `vllm.yaml` reuses `hope-secrets.MINIO_ACCESS_KEY` /
`MINIO_SECRET_KEY`, already present for `hope-stt`.~~ That pair is the
platform-wide read/**write** credential and can reach the PHI buckets; TASK-824's
sync Job had already moved to a least-privilege reader, so vLLM was the outlier.

> **Aside, for whoever owns TASK-828.** `hope-secrets` carries a
> `kubectl.kubernetes.io/last-applied-configuration` annotation containing the
> full `stringData` block — every platform secret in cleartext, including
> `DATABASE_URL`, `JWT_SECRET_KEY`, the MinIO keys and cloud API keys. Anything
> that can read the Secret *object* reads them even when the `data` values are
> masked by the viewer. Rotating without stripping that annotation does not
> retire the old values.

---

## 9. ROOT_CONFIG_REQUESTs — what the orchestrator/owner must create

These are outside this ticket's write boundary. The manifests are authored
against them and **fail closed** until they exist.

### 9.1 ~~Publish the ARCAAI Internal CA into `hope-v2-dev`~~ — **CANCELLED 2026-08-30**

> **CANCELLED BY OWNER DECISION, 2026-08-30. Recorded, not deleted.**
>
> The directive: *"No CA. At all."* For vLLM and LM Studio, every trace of the
> private "ARCAAI Internal CA" is removed — the `arcaai-internal-ca` ConfigMap
> volume, `AWS_CA_BUNDLE`, `VLLM_S3_CA_BUNDLE`, the `/etc/ssl/arcaai/ca.crt`
> mount, and `mc`'s CA flags. **Authentication to MinIO is a MinIO service
> account — an access key and a secret — and nothing else.**
>
> **"No CA" is about AUTHENTICATION, not TRANSPORT.** The endpoint stays
> `https://10.10.1.102:9000` — MinIO serves TLS on :9000 and one port serves one
> scheme, so plain HTTP would have forced pgBackRest, GitLab, Loki, Tempo,
> Prometheus and both cloudflared origins to be re-pointed as collateral. What
> replaces the CA is **certificate verification turned OFF at the client**.
>
> The accompanying directive is that **PHI hardening is explicitly
> DE-PRIORITISED for now**. This request is the single largest thing that
> de-prioritisation removes, so it is left here struck through rather than
> deleted: when PHI hardening is re-prioritised, THIS is the item to reinstate,
> and the collapsed block below is still the procedure.
>
> **What it cost.** An unverified TLS connection encrypts the wire but does NOT
> authenticate the peer: it defeats passive capture on `10.10.1.0/24`, not an
> on-path attacker. The egress NetworkPolicy still confines the traffic to a
> single `/32`.
>
> **⚠️ FOR vLLM THIS DOES NOT CURRENTLY WORK — OPEN-823-TLS.** vLLM's load path
> has two S3 clients and only the Run:ai C++ one reads `RUNAI_STREAMER_*`;
> **boto3 has no environment variable that disables verification**. §10's lab
> variant 2 (https + private CA + no `AWS_CA_BUNDLE`) IS this configuration and
> it failed `CERTIFICATE_VERIFY_FAILED` on the first LIST. Resolution is an owner
> decision: reinstate the CA for vLLM only (procedure below), put a
> publicly-trusted certificate on the MinIO listener, or patch the loader
> upstream. Not blocking while `replicas: 0`; blocking the moment it is scaled
> to 1. LM Studio is unaffected — `mc --insecure` is a real, verified control.

<details>
<summary>The original (cancelled) request, kept for reinstatement</summary>

`vllm.yaml` mounted ConfigMap `arcaai-internal-ca`, key `ca.crt`. It does not
exist; the namespace has no CA material at all. Without it the pod stopped at
`CreateContainerConfigError` — deliberately, rather than talking to a PHI
object store without verifying it.

The CA to publish is the issuer of MinIO's leaf, identified by:

```
CN=ARCAAI Internal CA, OU=Infrastructure, O=ARCAAI, L=Melbourne, ST=Victoria, C=AU
Authority Key Identifier of the leaf: 50:0E:C5:26:8E:A4:43:3F:21:16:93:AA:4E:0A:EF:D8:D8:2A:6F:45
```

MinIO serves only its leaf (a 1-certificate chain), so the CA cannot be scraped
off the wire — it has to come from wherever it was generated (most likely the
MinIO host `10.10.1.102`, cf. `ssh-minio.taphuynh.dev`). Once you have the PEM:

```sh
kubectl -n hope-v2-dev create configmap arcaai-internal-ca --from-file=ca.crt=./arcaai-ca.crt
```

Then verify it is the right CA before trusting it:

```sh
openssl verify -CAfile ./arcaai-ca.crt <(openssl s_client -connect 10.10.1.102:9000 \
  -servername s3.taphuynh.dev </dev/null 2>/dev/null | openssl x509)
```

This belongs in the deployment repo as a committed manifest, not a one-off
`kubectl create` — a CA cert is public material, so there is no reason for it to
live outside Git. It expires **2028-03-21**; put that in whatever tracks renewals.
</details>

### 9.1b Create the `hope-models-reader` Secret (BLOCKING — replaces 9.1)

This is now the **only** hand-created object `vllm.yaml` depends on, and it is
shared with TASK-824's LM Studio sync Job — create it once.

`vllm.yaml` reads `hope-models-reader`, keys `accessKeyId` / `secretAccessKey`.
The credential is a **MinIO service account** narrowed by the committed policy
`infrastructure/docker/minio/policies/hope-models-reader.json` (ListBucket +
GetObject + GetObjectVersion on `hope-models` only; no `PutObject`, no
`DeleteObject`, no other bucket).

```sh
mc admin policy create hope hope-models-reader \
  infrastructure/docker/minio/policies/hope-models-reader.json
mc admin user svcacct add hope <parent-user> \
  --access-key <19-char-key> --secret-key <secret> \
  --policy infrastructure/docker/minio/policies/hope-models-reader.json
kubectl -n hope-v2-dev create secret generic hope-models-reader \
  --from-literal=accessKeyId=<key> --from-literal=secretAccessKey=<secret>
```

⚠️ **MinIO rejects an access key longer than 20 characters** (`access key length
should be between 3 and 20`) — measured, not guessed.

This deliberately REPLACES the previous "reuse `hope-secrets.MINIO_ACCESS_KEY` /
`MINIO_SECRET_KEY`" arrangement (old §8.6): that pair is the platform-wide
read/WRITE credential that can also reach the PHI buckets, and a weight fetch has
no business holding a credential that can write `recordings`.

The full operator procedure, with the four verification commands that prove the
policy denies writes, is in
`docs/operations/inference/serving-tier-cluster-deployment.md` §4.

### 9.2 Create the `hope-models` bucket (BLOCKING for a real load)

Versioned, per §8.5 step 3. It does not exist yet on `10.10.1.102`.

### 9.3 Bring the rest of the platform onto the LAN MinIO endpoint (NOT blocking, but larger)

This ticket changes **only vLLM's** view of MinIO. Everything else still goes
through the tunnel, because `hope-secrets.MINIO_ENDPOINT = s3.taphuynh.dev` and
`hope-api-config.MINIO_USE_SSL = true`.

That means **every PHI object read and write — consultation audio, artifacts —
currently leaves the cluster for the public internet and comes back**, over a
hostname that TASK-828 §4 records as having no Cloudflare Access application.
The ~248× latency penalty measured in §8.1 applies to all of it.

Fixing it is the same two changes made here (`MINIO_ENDPOINT` → the LAN
address, plus CA trust for the clients), but it touches `hope-api`, `hope-stt`
and anything else holding a MinIO client, so it needs its own ticket and its own
verification. Raising it here; not doing it here.

### 9.4 TASK-828 follow-ups surfaced in passing

- `hope-secrets` leaks every secret in cleartext via its
  `last-applied-configuration` annotation (§8.6 aside).
- Two tunnel routes reach MinIO (`s3`, `s3-console`) with no Access application.
  Once in-cluster consumers use the LAN address, the question of whether those
  routes need to be public at all is worth asking — removing them would close
  the exposure rather than authenticate it.

---

## 10. Evidence — the Phase 2 lab run

Isolated compose project `hope-vllm-minio-verify`, publishing no host ports, on
its own bridge network. MinIO served over TLS with a leaf issued by a private CA
whose SAN mirrors the real one (`DNS:minio`, `DNS:localhost`, `IP:127.0.0.1`),
so the CA and hostname-verification behaviour match the cluster's. Torn down
after the run; the shared dev stack was not touched.

**The client exercises vLLM's own loader transport.** `stream_test.py` calls
`pull_files` → `list_safetensors` → `SafetensorsStreamer.stream_files` →
`get_tensors()` — precisely the chain in `vllm/config/model.py:704-722` and
`runai_streamer_loader.py:50-92` (via `weight_utils.runai_safetensors_weights_iterator`).
Everything except the final `.to("cuda")`.

Model: **`Qwen/Qwen3-4B-AWQ`**, sha256 verified against HuggingFace's published
LFS digest *before upload*
(`a7043493ebd993f5fea18794ad7b5b3e064a52023f392a7fcce7ce0984c341f0`, 2 666 027 672 B).

| # | Variant | Result |
|---|---|---|
| 1 | **Baseline** — `https://minio:9000`, path-style, CA bundle | **OK — 902 tensors, 2.483 GiB, 10.51 s, 241.8 MiB/s** |
| 2 | No `AWS_CA_BUNDLE` | **FAILS** — `botocore.exceptions.SSLError … CERTIFICATE_VERIFY_FAILED` on the first LIST |
| 3 | `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=1` | **FAILS** — see the failure signature below |
| 4 | `RUNAI_STREAMER_S3_ENDPOINT` unset, `AWS_ENDPOINT_URL` only | OK — 902 tensors, 556.6 MiB/s |
| 5 | **IP-SAN path** — connect to `https://127.0.0.1:9000`, verify against the CA | OK — 902 tensors, 970.3 MiB/s |
| 6 | URI without trailing slash, decoy `v10/` present | OK — selected only `v1/model.safetensors` |

Tensors materialised as genuine AWQ W4A16 structures — e.g.
`model.layers.13.self_attn.k_proj.qzeros [20,128] torch.int32` and
`model.layers.9.self_attn.o_proj.scales [32,2560] torch.float16` — so this is a
real quantized checkpoint being read, not an opaque byte copy.

Row 5 is the one that matters for the cluster: it is the same shape as
`https://10.10.1.102:9000`, whose leaf carries `IP:10.10.1.102`.

Throughput varies across rows because of page-cache warmth on the MinIO side,
not because of the settings under test. **Do not read these as cluster cold-start
numbers** — different hardware, loopback/bridge rather than a physical LAN, and
no GPU. The number to record for real is the one from step 3 of §6, on the node.

### Pitfall #7's actual failure signature — correcting the ticket

TASK-823 §12 predicts "MinIO host-style DNS failures at load". The real failure
is both later and far more opaque:

```
ValueError: Could not receive runai_response from libstreamer due to:
            b'File access error'
```

No hostname, no bucket, no DNS text — the message comes from the C++ library.
And it arrives **after** `pull_files` and `list_safetensors` have already
succeeded, because those use boto3 while only `stream_files` uses the C++
client:

| Stage | Client | Reads |
|---|---|---|
| `pull_files` / `list_safetensors` | boto3 (Python) | `AWS_CA_BUNDLE`, `AWS_ENDPOINT_URL` |
| `stream_files` (the weights) | Run:ai C++ / AWS C++ SDK | `RUNAI_STREAMER_*` |

So the pod's config and tokenizer load cleanly, the shard is listed cleanly, and
only the weight read dies with `File access error`. If you see that string,
check `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING` first — and note that a smoke
test which only lists objects will pass with the setting wrong.

### What was NOT proven

- **No GPU load was performed.** No CUDA device was available to this session.
  Everything up to and including tensor materialisation in host memory is
  proven; `.to("cuda")`, CUDA-graph capture, the engine's `GPU KV cache size`
  line and `vllm bench serve` are all still outstanding, and §6 remains the
  order to do them in.
- **The lab ran the streamer on arm64**, not the cluster's x86_64. The transport
  is arch-independent, and the arm64 caveat in `runai_utils.py` proved stale
  (0.16.1 imports cleanly on arm64), but the vLLM image itself was not executed.
- **The `vllm/vllm-openai:v0.11.0` image was not run.** The streamer verdict is
  from its Dockerfile (§6 step 2), which is decisive about what is installed but
  is not the same as importing it from the published image.
- **The real MinIO at `10.10.1.102` was never authenticated to.** Reachability,
  latency and the certificate were measured; no bucket was created and no object
  was read or written there.
