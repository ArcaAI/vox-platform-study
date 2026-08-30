# Serving-Tier Cluster Deployment Runbook — LM Studio & vLLM

| | |
|---|---|
| **Audience** | Whoever deploys the self-hosted LLM serving tiers into the `hope-v2-dev` k3s namespace. Assumes you have **not** read TASK-823/TASK-824 — everything you need is here. |
| **Covers** | `hope-lmstudio` (GGUF tier, TASK-824) and `hope-vllm` (safetensors/AWQ tier, TASK-823), plus the one MinIO credential both of them share. |
| **Companion tickets** | `docs/implementation/TASK-824-LM-Studio-Service/` · `docs/implementation/TASK-823-vLLM-Inference-Service/` · `docs/implementation/TASK-832-MinIO-Internal-Access-And-Model-Bucket/` (owns the bucket layout and the platform-wide endpoint migration) |
| **Manifests live in** | `arca/hope-v2-deployment` → `deployment/k8s/base/`. The files in the ticket directories are **staged copies**; the orchestrator commits them to that repo. Nothing here has been applied to a cluster. |
| **Last updated** | 2026-08-30 |

> ⚠️ **`docs/operations/inference/README.md` contradicts this page** on which engine
> is the production tier. That page predates the owner decision of 2026-08-30 and
> still describes LM Studio as "local dev/test only". The current decision is
> **LM Studio + vLLM as the serving tiers**; treat this runbook as authoritative
> for cluster deployment and that page as authoritative for engine tuning.

---

## 1. What you are deploying, and what will actually run

Two OpenAI-compatible inference services, both of which take their model weights
from the platform's MinIO object store rather than from the public internet.

| | `hope-lmstudio` | `hope-vllm` |
|---|---|---|
| Weight format | GGUF | safetensors / AWQ |
| How weights arrive | A **PreSync Job** mirrors them from MinIO onto a PVC, verifies SHA256, and writes a `.ready` sentinel. The serving pod never speaks S3. | **Streamed at pod start** directly from MinIO by vLLM's Run:ai model streamer. No PVC, no init container. |
| Ships at | `replicas: 0` | `replicas: 0` |
| Can it actually run today? | **Not yet** — the container image has never been built. Its CI job (`build-lmstudio`) has never completed a pipeline. | **No** — hardware blocker, see below. |
| Reached at | `http://hope-lmstudio:1234/v1` | `http://hope-vllm:8000/v1` |

### Both ship scaled to zero, for two different reasons

- **vLLM is blocked on hardware and that is not going to change by deploying it.**
  The cluster's GPUs are 2× RTX 2000 Ada (16 GiB each). The sizing arithmetic in
  TASK-823 §2A shows the 20–40 concurrent-generation target is unreachable by
  roughly 3× on VRAM and 15× on memory bandwidth simultaneously; an 8B model at
  BF16 will not even load. The node has **no VRAM isolation of any kind**
  (`mig.capable=false`, `mps.capable=false`, `vgpu.present=false`, time-slicing
  only), so raising `gpu-memory-utilization` to compensate does not buy capacity —
  it buys a CUDA OOM whose victim is decided by allocation order, and the likely
  victim is `hope-stt`, a working production capability. **Enabling vLLM is an
  owner decision that needs a card in the A100/H100 class.** Deploy the manifests
  anyway: they are reviewable, version-controlled, and enabling later is a
  one-line change.
- **LM Studio is blocked on a CI image build**, and on the ordered Service cutover
  in §7. Its Deployment is scaled to zero deliberately so that registering it with
  Argo CD is safe.

---

## 2. Prerequisites

| # | Item | How to check |
|---|---|---|
| P-1 | `kubectl` access to the `hope-v2-dev` namespace | `kubectl -n hope-v2-dev get deploy` |
| P-2 | `mc` (MinIO client) and admin credentials for the MinIO host at `10.10.1.102` | `mc admin info <alias>` |
| P-3 | The `hope-models` bucket exists, versioned | §4 creates it if not |
| P-4 | GitLab registry pull secret `hope-registry-creds` exists in the namespace | `kubectl -n hope-v2-dev get secret hope-registry-creds` |
| P-5 | For LM Studio only: a completed `build-lmstudio` CI pipeline, with the image digest ready to pin | GitLab pipeline for the branch/tag |
| P-6 | For vLLM only: a GPU node that can actually hold the model (see §1) | `kubectl get nodes -o json \| grep nvidia.com/gpu.memory` |

**Not a prerequisite any more:** a private CA. See §3.

---

## 3. The MinIO access contract — read this before anything else

Both serving tiers reach MinIO the same way, and it is deliberately the simplest
thing that works.

| | Value |
|---|---|
| Endpoint | `https://10.10.1.102:9000` — a LAN host on the same `/24` as the k3s node |
| Transport | **HTTPS with certificate verification DISABLED.** TLS is on; the peer is not verified; there is no CA anywhere |
| Authentication | **A MinIO service account** — an access key and a secret. Nothing else |
| Bucket | `hope-models`, read-only for both tiers |
| Kubernetes Secret | `hope-models-reader`, keys `accessKeyId` and `secretAccessKey` |
| Kubernetes ConfigMaps | `hope-vllm-config` key `VLLM_S3_ENDPOINT_URL` · `hope-lmstudio-config` key `LMSTUDIO_S3_ENDPOINT_URL` |
| Where verification is turned off | `mc --insecure` (LM Studio sync Job, on **both** `mc` invocations) · `RUNAI_STREAMER_S3_VERIFY_SSL=0` (vLLM — but read §3.4, it is not sufficient) |

### Four things behind that table

**1. No private CA — cancelled by owner decision, 2026-08-30.**
Until 2026-08-30 both manifests mounted a ConfigMap called `arcaai-internal-ca`
holding the "ARCAAI Internal CA" certificate, because MinIO serves a TLS leaf
issued by that private CA. That ConfigMap **did not exist in the namespace and
never did**, so it was raised as a blocking ROOT_CONFIG_REQUEST (R-1) in both
tickets. The owner cancelled it: no CA anywhere; the service-account key pair is
the only authentication. R-1 is **CANCELLED, not silently dropped** — it is
recorded as cancelled in both tickets, with the full procedure preserved, so it can
be reinstated rather than re-derived.

**2. "No CA" settles authentication; it does NOT mean plain HTTP.**
The scheme stays `https://`. MinIO serves TLS on :9000 and **one port serves one
scheme**, so moving these two workloads to plain HTTP would have forced
pgBackRest, GitLab, Loki, Tempo, Prometheus and both cloudflared origins to be
re-pointed as collateral. What replaces the CA is **verification turned off at each
client**, explicitly, with a comment at the point it happens.

Measured against a stand-in MinIO with the same TLS shape (§8):

```
plain HTTP -> TLS listener   Client sent an HTTP request to an HTTPS server
https, no --insecure         x509: certificate signed by unknown authority
https + --insecure           works
```

**3. The endpoint is NOT a secret, and no longer lives in one.**
It used to be `hope-secrets.MINIO_ENDPOINT` (still holding the *public* Cloudflare
tunnel hostname `s3.taphuynh.dev` in `secrets.dev.yaml.example:55`). Per
`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers, a transport
address belongs in the `env` tier, so it is now a **ConfigMap key referenced
non-optionally**. That matters practically: a stale Secret value fails *open* onto
the public internet, whereas a missing ConfigMap key fails the pod with
`CreateContainerConfigError`. TASK-832 is doing the same migration for `hope-api`,
`hope-stt` and `hope-harness`.

**4. ⚠️ What this relaxation costs — and where to undo it.**
An unverified TLS connection **encrypts the wire but does not authenticate the
peer**. It defeats passive capture on `10.10.1.0/24`; it does not defeat an on-path
attacker who can answer on that address. The egress NetworkPolicies still confine
the traffic to a single `/32`. Model **integrity** is unaffected either way — the
LM Studio sync Job verifies every file against the prefix's own `SHA256SUMS` and
refuses to flip its sentinel on a mismatch. Only confidentiality and peer
authenticity are relaxed.

**PHI hardening is explicitly de-prioritised for now by owner directive.** This is
the section to undo when it stops being. Every place verification is disabled
carries a comment saying so, so they are greppable:

```bash
grep -rn 'insecure\|VERIFY_SSL\|VERIFICATION IS DELIBERATELY DISABLED' \
  docs/implementation/TASK-82{3,4}-*/deployment*/
```

Reinstatement, per tier:

| Tier | Undo |
|---|---|
| LM Studio | Drop `--insecure` from **both** `mc` calls (the `config host add` in the container args, and `mc mirror` inside `sync.sh` — `mc` evaluates the flag per invocation), and restore `SSL_CERT_FILE=/etc/ssl/arcaai/ca.crt` plus the `arcaai-ca` ConfigMap volume + mount |
| vLLM | Restore `AWS_CA_BUNDLE` + the `VLLM_S3_CA_BUNDLE` ConfigMap key + the CA volume; drop `RUNAI_STREAMER_S3_VERIFY_SSL` |

Neither endpoint line changes.

### 3.4 ✅ OPEN-823-TLS — RESOLVED 2026-08-30: put a publicly-trusted certificate on MinIO

**Owner ruling: the MinIO listener gets a publicly-trusted certificate.** No
private CA is reinstated, and vLLM needs no patch — verification simply
succeeds, which is the one shape both of its S3 clients already support.

This is an operator action outside both repositories: obtain a certificate for
the MinIO host from a public issuer and install it on the :9000 listener. It is
not blocking today — vLLM ships at `replicas: 0` for the hardware reason — but
it MUST be in place before anyone scales it to 1.

Two follow-on simplifications it unlocks, both one-line: `minio.certCheck` can
go back to `true` platform-wide (the descriptor exists precisely so this is a
config change, not a code change), and `mc --insecure` can come off both
invocations in the sync Job.

The measurement below stands as the reason this ruling was needed.

#### Why verification-off does not work for vLLM (historical, still true)

This is a measurement, not a caveat. vLLM's weight-load path uses **two** S3
clients:

| Stage | Client | Verification control |
|---|---|---|
| config, tokenizer, shard listing | **boto3 / botocore** | `AWS_CA_BUNDLE` only. **No environment variable disables verification** — `verify=False` is a client-construction argument, and vLLM constructs the client itself |
| the weights | Run:ai C++ / AWS C++ SDK | `RUNAI_STREAMER_*` |

TASK-823's Phase 2 lab ran exactly this configuration — https endpoint, private
CA, no `AWS_CA_BUNDLE` — as its variant 2, and it **failed**
`botocore.exceptions.SSLError … CERTIFICATE_VERIFY_FAILED` on the first LIST.

So vLLM is expected to fail at startup under the no-CA directive unless one of:

- **(a)** the CA is reinstated for vLLM only (R-1's procedure is preserved in
  TASK-823 `deployment/README.md` §9.1);
- **(b)** the MinIO listener presents a publicly-trusted certificate;
- **(c)** vLLM's loader is patched upstream to honour a verify-off setting.

All three are owner decisions. **This is not blocking today** — vLLM ships at
`replicas: 0` for an unrelated hardware reason (§1). It becomes blocking the moment
someone scales it to 1. LM Studio is unaffected: `mc --insecure` is a real,
documented, verified control.

---

## 4. Step 1 — what an operator must create by hand

Four objects. Nothing else in this runbook works until they exist.

### 4.1 The `hope-models` bucket (once, on the MinIO host)

```bash
# Point mc at MinIO with an ADMIN credential. HTTPS with verification off, per §3
# — `--insecure` is required on EVERY mc invocation, it is not remembered by the
# alias.
mc --insecure alias set hope https://10.10.1.102:9000 <root-access-key> <root-secret>

# Versioned, because that is what makes a promoted model URI immutable and a bad
# promotion recoverable without re-uploading.
mc --insecure mb --with-versioning hope/hope-models
```

**Verify:** `mc ls hope/` lists `hope-models`.

### 4.2 The read-only policy (once)

The policy JSON is committed at
`infrastructure/docker/minio/policies/hope-models-reader.json`. Do not retype it.

```bash
mc --insecure admin policy create hope hope-models-reader \
  infrastructure/docker/minio/policies/hope-models-reader.json
```

It grants exactly `s3:ListBucket` + `s3:GetBucketLocation` on `hope-models`, and
`s3:GetObject` + `s3:GetObjectVersion` on `hope-models/*`. **No `PutObject`, no
`DeleteObject`, no other bucket.**

**Verify:** `mc admin policy info hope hope-models-reader`.

### 4.3 The MinIO service account (once)

```bash
mc --insecure admin user svcacct add hope <parent-user> \
  --access-key  <19-char-access-key> \
  --secret-key  <secret> \
  --policy infrastructure/docker/minio/policies/hope-models-reader.json
```

Three things that will bite you:

- **The access key must be 3–20 characters.** MinIO rejects anything longer with
  `access key length should be between 3 and 20` — measured, not guessed.
- `<parent-user>` is the MinIO user the service account inherits from; the
  `--policy` flag then *narrows* it to the reader policy. A service account can
  never exceed its parent, so do not parent it to something that lacks read on
  `hope-models`.
- TASK-832 records an **equivalent** procedure that creates a full MinIO *user*
  (`mc admin user add` + `mc admin policy attach`) instead of a service account.
  Either produces an access key + secret and the Kubernetes Secret is identical.
  A service account is preferred: it is revocable on its own without touching a
  user, and it carries the narrowing policy inline.

**Verify — all four of these, because "it can read" is only half the contract:**

```bash
mc --insecure alias set reader https://10.10.1.102:9000 <access-key> <secret>
mc --insecure ls --recursive reader/hope-models/            # expect: OK
mc --insecure cp /etc/hostname reader/hope-models/nope.txt  # expect: Insufficient permissions
mc --insecure rm reader/hope-models/<some-object>           # expect: Access Denied
mc --insecure ls reader/recordings/                         # expect: Access Denied
```

All four were exercised against a real MinIO over TLS during validation and
behaved exactly as listed. TASK-832's lane measured the same policies
independently and additionally confirmed that **neither** the reader nor the
publisher service account holds `DeleteObject`.

### 4.4 The Kubernetes Secret

```bash
kubectl -n hope-v2-dev create secret generic hope-models-reader \
  --from-literal=accessKeyId=<access-key> \
  --from-literal=secretAccessKey=<secret>
```

The key names `accessKeyId` / `secretAccessKey` are referenced non-optionally by
both `vllm.yaml` and the LM Studio sync Job. **One Secret serves both serving
tiers** — do not create a second.

**Verify:** `kubectl -n hope-v2-dev get secret hope-models-reader -o jsonpath='{.data}' | tr ',' '\n'`
shows exactly those two keys.

---

## 5. Step 2 — publish the models

The bucket layout is **owned by TASK-832**
(`infrastructure/docker/minio/README.md` §5.5); this runbook only consumes it. In
outline:

```
s3://hope-models/<slug>/<version>/
    <weights files>
    SHA256SUMS          <- plain text, `sha256sum` format, written by the publisher
```

Two properties that matter operationally:

1. **`<version>` is content-addressed** (`<quant>-<sha256-12>` of `manifest.json`),
   so it is not knowable until *after* publication. This is why the LM Studio
   manifest ships `SET-AT-PUBLISH` placeholders.
2. **Promotion is a NEW prefix, never an overwrite.** That is what makes rollback
   a config change rather than a re-upload — and why the PVC is sized to hold a
   replacement alongside the current set.

Publish, verify what landed, then **fill in `models.tsv`** in
`deployment/k8s/base/lmstudio.yaml`'s `hope-lmstudio-manifest` ConfigMap, replacing
every `SET-AT-PUBLISH` with the real version string.

**The Job refuses to run until you do.** Verified by running it:

```
sync: endpoint=http://... bucket=hope-models dest=/models
  FATAL gemma4-e2b-it-qat: version is unset. The prefix is content-addressed
        (<quant>-<sha256-12> of manifest.json) and is known only after
        publication. Fill models.tsv — see deployment-llmster/README.md R-3.
  ...
sync: FAILED — sentinel NOT written; serving pods will refuse to start.
```

That is the designed behaviour, not an error to work around: a silently-wrong
version syncs a *different* model, and content-addressed prefixes make that
undetectable downstream.

---

## 6. Step 3 — register the manifests (safe; nothing serves yet)

Copy the staged files into `arca/hope-v2-deployment`:

| From (this repo) | To |
|---|---|
| `docs/implementation/TASK-824-.../deployment-llmster/lmstudio.yaml` | `deployment/k8s/base/lmstudio.yaml` |
| `docs/implementation/TASK-824-.../deployment-llmster/config/lmstudio.env` | `deployment/k8s/base/config/lmstudio.env` |
| `docs/implementation/TASK-823-.../deployment/vllm.yaml` | `deployment/k8s/base/vllm.yaml` |
| `docs/implementation/TASK-823-.../deployment/config/vllm.env` | `deployment/k8s/base/config/vllm.env` |

**Do NOT copy `lmstudio-service-cutover.yaml` yet.** It is §7, and it is the one
step that can take production down.

Then, in the deployment repo:

1. Add both workload files to `base/kustomization.yaml` `resources:`, each with a
   comment saying why.
2. Add both `.env` files as `configMapGenerator` entries producing
   `hope-lmstudio-config` and `hope-vllm-config`.
3. Add `newName` + **digest** for the CI-built images to
   `overlays/dev/kustomization.yaml` `images:`. Never hand-edit staging/prod — the
   app repo's `promote-*` jobs write those.
4. `kustomize build deployment/k8s/overlays/dev` locally before pushing.

**Verify before pushing:**

```bash
kubeconform -summary -strict -kubernetes-version 1.35.0 \
  deployment/k8s/base/lmstudio.yaml deployment/k8s/base/vllm.yaml
kubectl -n hope-v2-dev apply --dry-run=server -f deployment/k8s/base/lmstudio.yaml
kubectl -n hope-v2-dev apply --dry-run=server -f deployment/k8s/base/vllm.yaml
```

Both were run against a live API server during validation and are clean.

Everything registered at this point is inert: vLLM and LM Studio are both at
`replicas: 0`, and the sync Job fails closed on the `SET-AT-PUBLISH` placeholders
if you skipped §5.

---

## 7. Step 4 — the LM Studio Service cutover (the dangerous step)

**Read `lmstudio-service-cutover.yaml` in full before touching the Service.**

### Why it is dangerous

`hope-lmstudio` **already exists** in `hope-v2-dev` as a *selector-less* Service
plus hand-written `Endpoints` pointing at the node host `10.10.1.10:1234` — an
LM Studio instance running on the VM host, applied **outside** kustomize and Argo
CD (`deployment/k8s/out-of-band/lmstudio-service.yaml` and `-endpoints.yaml`).

It carries live traffic today:

| Caller | How it reaches LM Studio | Allowed by the new policy? |
|---|---|---|
| `hope-text` | Per request, via the `baseUrl` on the SYSTEM `AiProviderConnection` row — the summarization/live path | **Yes** — the only peer |
| `hope-harness` | `HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL=http://hope-lmstudio:1234/v1` (`base/harness.yaml:110`) — Institutional-RAG embeddings | **No** — see the blocker below |
| `hope-harness-worker` | The same variable (`base/harness-worker.yaml:123`) | **No** — same |
| `hope-guardrail` | **Indirectly**, through `hope-text`. It no longer dials any LLM itself | Yes, transitively |

The new Service has the **same name**, so applying it is a REPLACE: the endpoints
controller takes ownership and discards the hand-written `10.10.1.10` subset. Apply
it while the Deployment is still at `replicas: 0` and `hope-lmstudio` resolves to
**nothing** — summarization and harness embeddings both break, and the failure
looks like an LLM outage rather than a networking change.

That is the same class of failure as the 2026-08-09 outage the out-of-band files
document at length.

### ⚠️ Blocker you must close first — the two harness callers

**Owner ruling:** internal peers reach LM Studio **through the gateway**
(`hope-api` → `hope-text` → LM Studio), never by dialling it. The ingress policy
therefore admits `hope-text` **only**.

But `hope-harness` and `hope-harness-worker` are configured *today* to dial it
directly, and are live against the out-of-band Service. The moment the policy is
enforced their embeddings calls are dropped — and the symptom reads as an
embeddings outage, not as a policy decision. Verified in the lab: with the shipped
policy applied, both harness stand-ins go from ALLOWED to BLOCKED.

**Re-point both Deployments through the gateway before step 7. Do not widen the
ingress rule.** Confirm with:

```bash
grep -rn 'hope-lmstudio' deployment/k8s/base/harness*.yaml   # expect: no output
```

### The order, and it is not negotiable

1. Merge `lmstudio.yaml` only (§6). Nothing serves.
2. Publish the models and fill `models.tsv` (§5). Let the PreSync Job run and write
   `.ready`.
3. Read real free VRAM on the node, and **stop or account for the LM Studio
   instance running on the HOST** — it holds VRAM the scheduler cannot see.
4. Scale the Deployment to 1. Wait for Ready. The readiness probe proves the model
   is actually resident, not merely that the process is up.
5. Verify the **pod** directly, bypassing the Service:
   ```bash
   kubectl -n hope-v2-dev exec deploy/hope-lmstudio -- \
     curl -fsS http://127.0.0.1:1234/api/v1/models
   ```
   Confirm every key in `imports.tsv` appears, with a non-empty `loaded_instances[]`
   for the one you preloaded.
6. Verify the **NetworkPolicy peer set** from the callers, still bypassing the
   Service — use the pod IP so a policy failure is not confused with a DNS failure.
   The peer set is `hope-text` and nothing else:
   ```bash
   POD_IP=$(kubectl -n hope-v2-dev get pod -l app=hope-lmstudio \
              -o jsonpath='{.items[0].status.podIP}')
   # ALLOW half — expect 200:
   kubectl -n hope-v2-dev exec deploy/hope-text -- \
     curl -fsS --max-time 5 http://$POD_IP:1234/api/v1/models
   # DENY half — each must TIME OUT:
   for app in hope-nlp hope-harness; do
     kubectl -n hope-v2-dev exec deploy/$app -- \
       curl --max-time 5 http://$POD_IP:1234/api/v1/models
   done
   ```
7. **Only now** apply `lmstudio-service-cutover.yaml`. Single object replace.
8. Re-verify **through** the Service, by name, from each caller:
   ```bash
   kubectl -n hope-v2-dev exec deploy/hope-text -- \
     curl -fsS http://hope-lmstudio:1234/api/v1/models
   ```
9. Delete the retired out-of-band files from the deployment repo
   (`out-of-band/lmstudio-service.yaml`, `out-of-band/lmstudio-endpoints.yaml`).
   This is part of the job, not later cleanup — leaving them means the next person
   re-applies a hand-written `Endpoints` over a working selector and reproduces the
   2026-08-09 outage exactly.

### Rollback

If step 7 goes wrong: **re-apply the two out-of-band files.** They point back at the
host instance. This is why step 3 says "stop or *account for*" — do not uninstall
the host instance until the cutover has soaked.

---

## 8. Network posture — what is enforced, and what is only claimed

LM Studio has **no headless authentication of any kind**. There is no way to mint a
token without a GUI, so the ingress NetworkPolicy is the **only** enforcement point
in front of it — not defence in depth. Treat any change to the peer list as a
security change.

Three policies ship with LM Studio, one pair with vLLM:

| Policy | Selects | Allows |
|---|---|---|
| `hope-lmstudio-ingress` | `app: hope-lmstudio` | inbound `:1234` from **`hope-text` only** — internal peers arrive through the gateway, never directly |
| `hope-lmstudio-egress` | `app: hope-lmstudio` | outbound DNS only |
| `hope-lmstudio-model-sync-egress` | `app: hope-lmstudio` **and** `app.kubernetes.io/component: model-sync` | outbound DNS + `10.10.1.102/32:9000` |
| `hope-vllm-ingress` | `app: hope-vllm` | inbound `:8000` from `hope-text` and `prometheus` |
| `hope-vllm-egress` | `app: hope-vllm` | outbound DNS + `10.10.1.102/32:9000` |

**Why LM Studio needs two egress policies.** NetworkPolicies are additive: a pod
selected by two of them may do the union. The sync Job's pod carries *both* labels,
so it gets DNS + MinIO; the serving pod carries only the first, so it gets DNS and
no S3 path at all. Before this split, the DNS-only policy also selected the sync Job
and would have blocked the very `mc mirror` the Job exists to run — a defect found
during validation, not in review.

### ⚠️ Verify enforcement on the real cluster before believing any of the above

k3s ships a NetworkPolicy controller with its default flannel CNI, but
`--disable-network-policy` turns it off, and the server flags are not readable
through the API. **An unenforced policy is worse than no policy, because it looks
like a control.** Step 6 of §7 is the check. If a non-peer pod gets a 200 instead of
a timeout, say so loudly — LM Studio is then completely unauthenticated to every
pod in the namespace.

**What was proven off-cluster, and where it stops:** on a single-node Kubernetes
1.35 (OrbStack) the shipped `hope-lmstudio-ingress` policy behaved exactly as
intended for long-lived pods — `hope-text` ALLOWED; `hope-harness`,
`hope-harness-worker` and `hope-nlp` all BLOCKED — against a clean baseline where
all four were allowed with no policy in place. **That is a different CNI from
k3s/flannel and proves nothing about the real cluster.** Egress on that same CNI
showed a **programming race**: a freshly-created pod reached a destination its
policy forbids at t=0 and was correctly blocked at t=45s, reproduced twice. If that
behaviour also exists on k3s, a short-lived Job can slip past an *egress* policy —
which is one more reason the sync Job's own SHA256 verification, not the network
policy, is the control that guarantees model integrity.

---

## 9. Verification checklist

| # | Check | Expected |
|---|---|---|
| V-1 | `curl -k https://10.10.1.102:9000/minio/health/live` from a namespace pod | HTTP 200 |
| V-2 | `mc --insecure ls reader/hope-models/` with the service account | lists the published prefixes |
| V-3 | `mc --insecure cp … reader/hope-models/…` | **denied** |
| V-4 | `kubectl get secret hope-models-reader` | exists, two keys |
| V-5 | `kubeconform` + `apply --dry-run=server` on both workload files | clean |
| V-6 | `grep -rn 'hope-lmstudio' deployment/k8s/base/harness*.yaml` | **no output** — the §7 blocker is closed |
| V-7 | LM Studio sync Job logs | `verified <prefix>` then `sync: OK — … sentinel written.` |
| V-8 | `kubectl exec` into the sync Job's PVC consumer, `ls /models/staging` | one directory per row of `models.tsv` |
| V-9 | LM Studio pod readiness | Ready — the probe asserts model residency, not just process liveness |
| V-10 | §8 peer-set probe (allow **and** deny halves) | `hope-text` 200; every other pod times out |
| V-11 | `curl http://hope-lmstudio:1234/api/v1/models` from `hope-text` | 200, every expected key present |

---

## 10. Rollback

| Situation | Action |
|---|---|
| vLLM fails `CERTIFICATE_VERIFY_FAILED` at startup (OPEN-823-TLS, §3.4) | Reinstate the CA for vLLM only: restore `AWS_CA_BUNDLE`, the `VLLM_S3_CA_BUNDLE` ConfigMap key and the `arcaai-internal-ca` volume. Procedure preserved in TASK-823 `deployment/README.md` §9.1. LM Studio needs no change |
| PHI hardening is re-prioritised | Undo every relaxation listed in §3 item 4 — both tiers, endpoints unchanged |
| Service cutover broke callers (§7 step 7) | Re-apply `out-of-band/lmstudio-service.yaml` and `out-of-band/lmstudio-endpoints.yaml`; traffic returns to the host instance |
| A bad model was promoted | Repoint `models.tsv` at the previous prefix and re-run the PreSync Job. Prefixes are immutable and versioning is on, so the old bytes are still there |
| LM Studio pod is unhealthy | Scale to 0. The Service then has no endpoints — so scale to 0 **and** re-apply the out-of-band files if you need the host instance back |
| vLLM OOMs a co-tenant (e.g. `hope-stt`) | Scale `hope-vllm` to 0 immediately. Do not "tune" `VLLM_GPU_MEMORY_UTILIZATION` upward — under time-slicing nothing enforces the sum across pods |

---

## 11. Known-unprovable items — do not read these as passing

Recorded plainly so that a green checklist is not mistaken for a working system.

| # | Item | Why it could not be proven |
|---|---|---|
| U-1 | The LM Studio image works at all | It has **never been built**. CI is the only builder (owner directive); no local build result counts as evidence |
| U-2 | Anything about GPU execution — offload, VRAM residency, throughput, co-tenancy | No GPU was available to any lane that touched this |
| U-3 | vLLM with verification disabled | **Worse than unproven — measured failing.** See §3.4 (OPEN-823-TLS): boto3 has no env var that disables verification, and TASK-823's Phase 2 lab measured exactly this shape failing `CERTIFICATE_VERIFY_FAILED` on the first LIST. `RUNAI_STREAMER_S3_VERIFY_SSL=0` is carried in the manifest but its name is **unverified** against the streamer source |
| U-4 | Anything about `10.10.1.102:9000` itself | Not reachable from the validating workstation (it is on a different subnet). Every transport claim in §3 was proven against a stand-in MinIO with the same TLS shape — self-signed leaf, no client trust — not against the real host |
| U-5 | NetworkPolicy enforcement on the real k3s cluster | Proven only on a different CNI (§8) |
| U-6 | LM Studio audio support | Unverified-negative. `audio-smoke-test.sh` in the ticket directory is delivered as an executable test, not a result |
| U-7 | Offline cold start with egress blocked | LM Studio is closed-source; its first-run telemetry behaviour cannot be read from source and must be observed |
