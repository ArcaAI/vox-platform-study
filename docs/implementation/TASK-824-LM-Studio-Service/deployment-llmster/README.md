# TASK-824 — LM Studio deployment handover (STAGED, NOT APPLIED)

Nothing here has been applied to a cluster, and nothing has been committed to
`hope-v2-deployment`. **The orchestrator makes every commit to that repo**
(EXECUTION-PLAN §14.5).

Engine choice is settled: **LM Studio (`llmster`) + vLLM**, per the owner
decision in the ticket README §0. The llama.cpp artifacts in `../deployment/`
and `../image/` are the record of the recommendation that was overruled, plus
the documented escape hatch (§2). They are left untouched.

---

## 1. Files to copy

| From (this directory) | To (`hope-v2-deployment`) | When |
|---|---|---|
| `lmstudio.yaml` | `deployment/k8s/base/lmstudio.yaml` | **Now** — safe, everything ships inert |
| `config/lmstudio.env` | `deployment/k8s/base/config/lmstudio.env` | Now |
| `lmstudio-service-cutover.yaml` | append to `base/lmstudio.yaml` | **ONLY at cutover step 6** |

`audio-smoke-test.sh` stays in **this** repo — it is verification tooling, not a
manifest.

The image is **not** here: it lives at `infrastructure/docker/lmstudio/` in this
repo, following the `infrastructure/docker/<name>/` convention already used by
`python-base` and `qdrant-init`, and it is built **only by CI**
(`.gitlab/ci/build.yml` → `build-lmstudio`).

Then, per EXECUTION-PLAN §14.4:

1. Register `lmstudio.yaml` in `base/kustomization.yaml` `resources:` **with a
   comment saying why**.
2. Add `config/lmstudio.env` as a `configMapGenerator` producing
   `hope-lmstudio-config`.
3. Add `newName` + `digest` for the CI-built `lmstudio` image to
   `overlays/dev/kustomization.yaml` `images:`. Never hand-edit staging/prod —
   the app repo's `promote-*` jobs write those.
4. `kustomize build deployment/k8s/overlays/dev` locally before pushing.

---

## 2. ⚠️ The cutover is ordered, and the order is not negotiable

**Read `lmstudio-service-cutover.yaml` in full before touching the Service.**

`hope-lmstudio` already exists as a selector-less Service + hand-written
Endpoints pointing at the node host `10.10.1.10:1234`, and it currently carries
the summarization path (`hope-text`), the harness Institutional-RAG embeddings
path (`hope-harness` + `hope-harness-worker`) and — indirectly, via `hope-text` —
the guardrail path. The new Service has the same name. Applying it while the
Deployment is at `replicas: 0` points `hope-lmstudio` at nothing and breaks all of
them — a failure that presents as an LLM outage rather than as a networking
change.

The ordered steps are in that file. The short version: **workload first, models
published, VRAM measured, scale to 1, verify the POD directly, prove the
NetworkPolicy peer set, and only then the Service** — followed by re-verifying
through the Service by name and deleting the two retired out-of-band files, which
is part of this ticket rather than later cleanup.

### Why the Service stays in its own file (re-confirmed 2026-08-30)

The owner's requirement is that `http://hope-lmstudio:1234` end up resolving to
the POD. Keeping the Service separate is what DELIVERS that rather than deferring
it: the Deployment ships at `replicas: 0` and the image has never been built, so
folding this object into `lmstudio.yaml` would have Argo CD REPLACE the live
selector-less Service on the next sync with **zero pods behind the new selector**
— producing exactly the outcome the requirement forbids, for as long as it takes
to build an image and schedule a GPU pod. Separation is the only ordering in which
the name resolves to a real backend at every instant. Step 6 of the cutover is
where the requirement is satisfied; step 6' is where it is proven.

---

## 3. ROOT_CONFIG_REQUESTS — blocking, owner/orchestrator only

| # | Item | Why it blocks |
|---|---|---|
| ~~**R-1**~~ | ~~ConfigMap `arcaai-internal-ca` (key `ca.crt`)~~ **CANCELLED 2026-08-30 — see below** | Struck through, not deleted. Reinstate it when PHI hardening is re-prioritised |
| **R-2** | **Secret `hope-models-reader`** (keys `accessKeyId`, `secretAccessKey`) — now the **ONLY** hand-created object this workload needs | A **MinIO SERVICE ACCOUNT** (access key + secret) narrowed by the least-privilege policy committed at `infrastructure/docker/minio/policies/hope-models-reader.json` — `ListBucket`/`GetObject`/`GetObjectVersion` on `hope-models` only, **no `PutObject`, no `DeleteObject`, no other bucket**. Never the root key, never the publisher key. **TASK-823's vLLM pod now reads this same Secret and the same key names**, so one service account serves both serving tiers — create it once. ⚠️ MinIO rejects an access key longer than **20 characters** (measured). Full procedure + the four verification commands: `docs/operations/inference/serving-tier-cluster-deployment.md` §4 |
| **R-3** | **Publish the models into `s3://hope-models/`, then fill `models.tsv`** | Two steps, and the second is easy to miss. **(a)** Publish per `infrastructure/docker/minio/README.md` §5.5 — that document owns the layout; this ticket only consumes it. **(b)** `<version>` is content-addressed (`<quant>-<sha256-12>` of `manifest.json`) and therefore unknowable until publication, so `models.tsv` ships `SET-AT-PUBLISH` placeholders and **the Job refuses to run until they are replaced**. |
| **R-4** | **Registry credentials + private-registry-only enforcement** | The image embeds a proprietary binary we hold no redistribution right to (§0 risk A-5, §5 L-2). `imagePullSecrets: hope-registry-creds` is on every pod spec here. Confirm the `lmstudio` repository is **not** mirrored anywhere public. |
| **R-5** | **Confirm k3s NetworkPolicy enforcement is on** (no `--disable-network-policy`) | Load-bearing here in a way it was not for llama.cpp: LM Studio has **no headless auth at all**, so the ingress policy is the *only* enforcement point (§5 L-1, risk A-4). A decorative policy is worse than none, because it looks like a control. |
| **R-6** | **Decide whether to add `LMS` to the release-tag grammar** | `<SVC>` is a closed set in `packages/utils/src/version-grammar.ts` (`ALL API ADMIN COMPAT GUARD HARNESS NLP TEXT STT TTS`). There is no LM Studio member, so `build-lmstudio` triggers on branch pushes and `ALL-` only — the same shape as `build-qdrant-init`. Adding `LMS-` edits `packages/**`, outside this lane's boundary. Workable as-is; raised so it is a decision rather than a gap. |
| **R-7** | **Verify (do not assume) the `AiProviderConnection` row** | See §5. Expected to be a **no-op**, which is exactly why it must be checked rather than skipped. |

### R-1 is CANCELLED — owner decision, 2026-08-30

The directive: **"No CA. At all."** Every trace of the private "ARCAAI Internal
CA" is removed from this workload and from TASK-823's — the `arcaai-internal-ca`
ConfigMap volume, `SSL_CERT_FILE`, `AWS_CA_BUNDLE`, `VLLM_S3_CA_BUNDLE`, the
`/etc/ssl/arcaai/ca.crt` mount, and `mc`'s CA flags. **Authentication to MinIO is
a MinIO SERVICE ACCOUNT — an access key and a secret — and nothing else.** The
accompanying directive is that **PHI hardening is explicitly DE-PRIORITISED for
now**.

**"No CA" settles AUTHENTICATION; it does not mean plain HTTP.** The transport
stays **`https://`**. MinIO serves TLS on :9000 and one port serves one scheme, so
moving this workload to plain HTTP would have forced pgBackRest, GitLab, Loki,
Tempo, Prometheus and both cloudflared origins to be re-pointed as collateral.
What replaces the CA is **certificate verification explicitly turned OFF at each
client**: `mc --insecure` here (on the `config host add` line *and* on `mc mirror`
inside `sync.sh` — `mc` evaluates the flag per invocation, it is not inherited),
and the vLLM equivalent in TASK-823.

R-1 is struck through rather than deleted because this is the single largest thing
that de-prioritisation removes: when PHI hardening is re-prioritised, R-1 is the
item to reinstate, and TASK-823 `deployment/README.md` §9.1 still carries the full
procedure inside a collapsed block.

**What it costs.** An unverified TLS connection **encrypts the wire but does not
authenticate the peer**: it defeats passive capture on `10.10.1.0/24` but not an
on-path attacker. `hope-lmstudio-model-sync-egress` still confines the traffic to
a single `/32`. Model **integrity** is unaffected either way — `sync.sh` verifies
every file against the prefix's own `SHA256SUMS` and refuses to write `.ready` on
a mismatch. Only confidentiality and peer authenticity are relaxed.

**Reinstatement is two edits**, both marked in place with the same wording so they
are greppable: drop `--insecure` from both `mc` invocations, and restore
`SSL_CERT_FILE=/etc/ssl/arcaai/ca.crt` plus the `arcaai-ca` volume and mount. The
endpoint line in `config/lmstudio.env` does not change.

### R-5 got an answer, on a different cluster — read the caveat

R-5 asks whether k3s is actually enforcing NetworkPolicy. It was **not** answered
on k3s. It was answered on a throwaway single-node Kubernetes 1.35 (OrbStack),
which is a **different CNI** and therefore proves nothing about `hope-v2-dev`:

- **Ingress: enforced, deterministically.** With no policy, all four probe callers
  reached the LM Studio stand-in. With the shipped `hope-lmstudio-ingress` applied,
  `hope-text` / `hope-harness` / `hope-harness-worker` were ALLOWED and `hope-nlp`
  was BLOCKED — exactly the intended peer set.
- **Egress: enforced for long-lived pods, but with a startup RACE.** A pod created
  fresh reached a destination its policy forbids at t=0 and was correctly blocked
  at t=45s; reproduced twice. If k3s behaves the same way, a short-lived Job can
  slip past an *egress* rule — which is one more reason the sync Job's own SHA256
  verification, not the network, is what guarantees model integrity.

R-5 stays OPEN for the real cluster. The check is step 5' of the cutover file.

---

## 4. What is deployed

| Object | Purpose |
|---|---|
| `hope-lmstudio-models` PVC (60Gi) | Warm, checksum-verified GGUF store. **Mounted read-WRITE by the serving pod** — see below |
| `hope-lmstudio-manifest` ConfigMap | `models.tsv` (what to sync), `imports.tsv` (how to publish + expected keys), `sync.sh` |
| `hope-lmstudio-model-sync` Job | PreSync/wave -1. MinIO → PVC staging, verify against the prefix's own `SHA256SUMS`, flip `.ready` |
| `hope-lmstudio` Deployment | `replicas: 0`. GPU, non-root, exec probes |
| **3** × NetworkPolicy | Ingress from `hope-text` ONLY (gateway ruling); serving-pod egress DNS only; **model-sync-Job egress** DNS + MinIO `/32` — see §4A |
| PDB + HPA | Inert, present for uniformity (§14.4 item 8) |
| `hope-lmstudio` Service | **In the cutover file, not here** |

## 4A. Network reachability — the peer set, and the one contradiction it exposes

The owner directive was: *"make sure lmstudio can interact with / can be
interacted by other internal services such as `text`."* The owner then **ruled on
the topology**: internal peers reach LM Studio **THROUGH THE GATEWAY**, not by
dialling it. `apps/text` fronts the engine; everything else arrives via
`hope-api` → `hope-text`.

So the ingress peer set is **`hope-text` and nothing else**, and it must not be
widened on the assumption that some other service calls the engine directly.

| Peer | Evidence | Verdict |
|---|---|---|
| `hope-text` | The SYSTEM `AiProviderConnection` row's `baseUrl` (`http://hope-lmstudio:1234/v1`); `openai_compat.py` dials it per request | **ALLOW** |
| `hope-harness` | `base/harness.yaml:110` — `HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL=http://hope-lmstudio:1234/v1` | **ALLOW** — owner ruling 2026-08-30, see §4A |
| `hope-harness-worker` | `base/harness-worker.yaml:123` — same variable, separate Deployment | **ALLOW** — same ruling |
| `hope-guardrail` | `base/guardrail.yaml` sets `TEXT_URL`/`NLP_URL`; its `GUARDRAIL_OPENAI_COMPAT_*` engine config was deleted (`06-python-services.md`) | **DENY** — the "guardrail path" the cutover file mentions is guardrail → text → lmstudio, and `hope-text` is already allowed |
| `hope-nlp`, `hope-api`, `hope-admin-console` | no `:1234` reference anywhere in the deployment repo or in service code | **DENY** |
| `prometheus` | LM Studio exposes **no** metrics endpoint (measured: `GET /metrics` → 200 `{"error":"Unexpected endpoint or method"}`) | **DENY** — a scrape rule would imply a signal that does not exist |

### ✅ OPEN-824-HARNESS — RESOLVED 2026-08-30 by owner ruling: widen the peer set

**The two harness workloads are admitted to the ingress policy. They keep dialling
LM Studio directly, and the Service cutover no longer drops them.**

The earlier "through the gateway" ruling was overturned on measurement, not
preference. The gateway's text surface is BUSINESS-plane: `UnifiedAuthGuard`
accepts a service-account token, an API key or a JWT, and never
`X-Service-Token`. Neither harness workload can authenticate to it today, and
the credential that would let them is tenant-bound with no wildcard in
`allowedTenantIds`. Holding the narrow peer set would not have routed harness
through the gateway — it would only have cut its embeddings off.

Two consequences worth stating rather than discovering later. Every entry in
that list is **unconditional access**: LM Studio has no authentication at all,
so the policy is the only control, and adding a label grants the full engine.
And this is an **embeddings** path, not a generation path — it does not go
through the router, so widening it does not license a generation call.

The historical analysis below is kept as the record of why this was raised.

#### The original finding (historical)

The gateway ruling and the cluster's current configuration disagree, and the
disagreement is live:

```
hope-v2-deployment  base/harness.yaml:110         HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL
hope-v2-deployment  base/harness-worker.yaml:123    = http://hope-lmstudio:1234/v1
```

Both are running today against the out-of-band Service. Under the ruling they are
**not** peers, so the moment this policy is enforced their Institutional-RAG
embeddings calls are dropped — and the symptom presents as an embeddings outage,
not as a policy decision.

**Resolution is to re-point those two Deployments through the gateway before
cutover step 6**, not to widen the ingress rule. That edit is in the deployment
repo and outside this lane's write boundary, so it is raised here rather than
made. The cutover file carries it as step 5'' with a `grep` that must come back
empty before proceeding.

**Egress needed a second policy, and finding out why was the point of validating.**
NetworkPolicy selects pods **by label**, and the model-sync Job's pod template also
carries `app: hope-lmstudio` — so the DNS-only `hope-lmstudio-egress` selected the
Job too and would have blocked the very `mc mirror` the Job exists to run. Adding a
MinIO rule to that policy would have "fixed" it by handing the serving pod an S3
path it has no use for. Instead the Job pod now carries
`app.kubernetes.io/component: model-sync` and a second, narrower policy
(`hope-lmstudio-model-sync-egress`) grants DNS + `10.10.1.102/32:9000` to that
label pair. Policies are additive, so the Job gets DNS + MinIO and the serving pod
keeps DNS only — which is the property the original policy was written to have.

**LM Studio still has no authentication of any kind**, so the ingress policy
remains the ONLY enforcement point (§5 L-1, ticket §0 risk A-4) rather than defence
in depth. Treat any change to the peer table above as a security change.

### Two differences from a llama.cpp deployment, both deliberate

1. **The models PVC is mounted read-write in the serving pod.** `lms import`
   hard-links into the models tree and the daemon maintains its index there, so
   a read-only mount would break publication. A llama.cpp pod can mount the same
   volume `ro`.
2. **No Prometheus annotations and no metrics ingress rule.** MEASURED: LM Studio
   exposes no metrics endpoint — `GET /metrics` returns **200** with
   `{"error":"Unexpected endpoint or method. (GET /metrics)"}`. This is a real
   observability regression versus llama.cpp and a consequence of the engine
   decision. Scrape annotations would imply a signal that does not exist.

---

## 5. `AiProviderConnection` — the SYSTEM row, and why it is probably a no-op

The seed row is `87000000-0000-0000-0000-000000000002`
(`packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:238`):

```
tenantId: SYSTEM   service: 'llm'   provider: 'lm-studio'
baseUrl:  'http://localhost:1234/v1'      <- the LOCAL-DEV value
enabled:  true    apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY ('not-needed')
```

**Required cluster value: `http://hope-lmstudio:1234/v1`.**

Because the new Service deliberately keeps the name `hope-lmstudio` and the port
`1234`, the DNS name `apps/text` already dials is unchanged by this migration.
The cluster row therefore **most likely already holds the correct value**, and
the action is to *verify* it, not to edit it:

```sql
SELECT "baseUrl", enabled FROM core."AiProviderConnection"
 WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
   AND service = 'llm' AND provider = 'lm-studio';
```

Two things that make this a check rather than a formality:

- **The seed is CREATE-ONLY.** An existing `(tenantId, service, provider)` row is
  never overwritten, so re-seeding will not fix a wrong value. If the row is
  wrong it must be corrected through the admin surface (an OCC write), not by a
  re-seed.
- **The row must keep its key material.** `apps/text` is on the fold path:
  `require_connection()` raises `ProviderConnectionMissingError` → **503** when
  the override is absent, with no env fallback. A row that is enabled but
  keyless is resolvable and never *delivered*. The `not-needed` placeholder is
  literally what `openai_compat.py` substitutes for an empty key — leave it.

### No router code change, and no `AiModel.provider` change

`apps/text` reaches LM Studio purely through `openai_compat.py`
(`_LM_STUDIO_PROVIDER_NAMES = {"lm-studio", "openai_compat"}`), so a
containerized LM Studio needs **no router code at all** — only this connection row.

⚠️ **Do not "tidy" the multimodal models onto `provider: 'llama-cpp'`.** That
value selects `LlamaCppProvider`'s raw `/completion` path: no chat template, no
image parts, no audio parts. Multimodal models stay on `'lm-studio'`
(ticket §0).

### The model keys are the part that can silently 404

`resolveTextSelectionForKey` puts `AiModel.sourceUri` on the wire as the OpenAI
`model` field. MEASURED: LM Studio derives a model's key from the **`<model>`
segment of `--user-repo`**, not from the filename. The seed values are pinned by
`ai-model-consolidation-seed.test.ts`, so they are the fixed point and
`imports.tsv` is written to match them:

| seed row | `sourceUri` (pinned) | `imports.tsv` user-repo |
|---|---|---|
| `lms-gemma-4-e2b-it-qat` | `gemma-4-e2b-it-qat` | `hope/gemma-4-e2b-it-qat` |
| `lms-gemma-4-e4b-it-qat` | `gemma-4-e4b-it-qat` | `hope/gemma-4-e4b-it-qat` |
| `granite-guardian-4.1-8b` | `granite-guardian-4.1-8b` | `hope/granite-guardian-4.1-8b` |

`entrypoint.sh` A-3 asserts every expected key is visible **before the server
accepts traffic**, so a mismatch fails at pod start with exit 78 rather than as
a 404 on a clinical request.

### The embedding model has nowhere to go yet

`text-embedding-embeddinggemma-300m-qat` is synced to the volume but is
**deliberately not in `imports.tsv` and not preloaded**. `apps/text` registers
exactly one embedding provider, `tei-embed`, and TEI cannot load a GGUF. That is
TASK-831 §9 **owner decision 2** and it is not this lane's to take. The weights
being present costs nothing and makes the decision cheap to act on later.

---

## 6. Open items that must be closed before clinical traffic

| # | Item | Why it matters |
|---|---|---|
| **OI-1** | **Does LM Studio auto-pair `*-mmproj.gguf`?** | Gemma 4's projector is a separate file carrying both encoders. llama.cpp needs an explicit `--mmproj` and is text-only without it; LM Studio has no equivalent flag on `lms load` or in the REST load body. If it does not auto-pair from the same directory, **both vision and audio are silently unavailable**. STEP 1 of `audio-smoke-test.sh` is the discriminator. |
| **OI-2** | **Audio (risk A-1)** | Unverified. See `audio-smoke-test.sh` and AUDIO_VERDICT in the report. |
| **OI-3** | **Offline cold start with egress blocked** (§4.9 item 9) | The egress policy allows DNS only. LM Studio is closed-source, so its first-run telemetry/EULA behaviour cannot be read from source and must be observed. If it blocks on a network call, the pod never becomes ready. |
| **OI-4** | **Which CUDA minor the `+cuda12` bundle actually links** | The arm64 bundle ships a **cuda13** engine (`llama.cpp-linux-arm64-nvidia-cuda13`). If the x64 `+cuda12` bundle likewise ships cuda13 engines, the `nvidia/cuda:12.8.1-runtime-ubuntu24.04` base may be the wrong minor. The entrypoint matches `cuda` generically and so tolerates either name, but the BASE IMAGE choice is unverified. `verify-lmstudio-runtime` in CI prints the engine list — read it on the first pipeline. |
| **OI-5** | **PLE correctness for E2B/E4B** (TASK-831 §4.1b) | Untouched here. Failure mode is silent quality loss, not an error. |
| **OI-6** | **Throughput** | §6: one LM Studio instance sustains single-digit-to-low-teens concurrent generations before p95 degrades, against a 20–40 in-flight target. It is a secondary/eval tier behind vLLM — do not let a `LEAST_BUSY` strategy promote it to the primary clinical path. |

---

## 7. What was actually RUN against a cluster (2026-08-30)

A throwaway namespace on a single-node Kubernetes 1.35 (OrbStack, `local-path`
StorageClass), created and deleted for this purpose. **It is not k3s and not
`hope-v2-dev`**, so read §7.3 before trusting any of it.

### 7.1 Static + API-level validation

```
$ kubeconform -summary -kubernetes-version 1.35.0 -strict vllm.yaml lmstudio.yaml lmstudio-service-cutover.yaml
Summary: 17 resources found in 3 files - Valid: 17, Invalid: 0, Errors: 0, Skipped: 0

$ kubectl -n hope-sim apply --dry-run=server -f lmstudio.yaml
persistentvolumeclaim/hope-lmstudio-models created (server dry run)
configmap/hope-lmstudio-manifest created (server dry run)
job.batch/hope-lmstudio-model-sync created (server dry run)
deployment.apps/hope-lmstudio created (server dry run)
networkpolicy.networking.k8s.io/hope-lmstudio-ingress created (server dry run)
networkpolicy.networking.k8s.io/hope-lmstudio-egress created (server dry run)
networkpolicy.networking.k8s.io/hope-lmstudio-model-sync-egress created (server dry run)
poddisruptionbudget.policy/hope-lmstudio created (server dry run)
horizontalpodautoscaler.autoscaling/hope-lmstudio created (server dry run)
```

### 7.2 The sync Job, run for real against a real **TLS** MinIO

A MinIO `RELEASE.2025-04-22T22-12-26Z` served **HTTPS with a self-signed
certificate** — deliberately mirroring the cluster's shape, where the leaf is
signed by a CA no client trusts. A service account was created with the committed
`hope-models-reader.json` policy, and a 64 KiB fake model plus `SHA256SUMS` was
published to `hope-models/simmodel/q4km-.../`.

**Three controls first, because they settle the transport question the owner
correction turned on:**

```
A) plain HTTP against the TLS listener
   mc: <ERROR> Unable to list folder. Client sent an HTTP request to an HTTPS server.
B) https:// WITHOUT --insecure  (i.e. no CA available)
   mc: <ERROR> Unable to list folder. Get "https://sim-minio:9000/":
              tls: failed to verify certificate: x509: certificate signed by unknown authority
C) https:// WITH --insecure
   Added `sim` successfully.   (and every subsequent operation works)
```

A is the measured confirmation that plain HTTP was never available here — one
port serves one scheme. B is why a CA-less client needs verification turned off
rather than simply omitted. C is the shipped configuration.

**BUG FOUND BY RUNNING IT — the Job could not start at all.** First run:

```
mc: <ERROR> Unable to save new mc config. mkdir /home/hope: permission denied.
```

`minio/mc` has no `/home/hope`, `/home` is root-owned, and the pod runs as uid
10001 — so `MC_CONFIG_DIR=/home/hope/.mc` killed the very first command before a
byte was fetched. Review had not caught it; the manifest now mounts an `emptyDir`
at `/home/hope`. **Every deploy of this Job would have failed on PreSync.**

Second run — the `SET-AT-PUBLISH` guard, working exactly as designed:

```
Added `hope` successfully.
sync: endpoint=http://sim-minio:9000 bucket=hope-models dest=/models
  FATAL gemma4-e2b-it-qat: version is unset. The prefix is content-addressed
        (<quant>-<sha256-12> of manifest.json) and is known only after
        publication. Fill models.tsv — see deployment-llmster/README.md R-3.
  ... (one per row) ...
sync: FAILED — sentinel NOT written; serving pods will refuse to start.
```

Third run, with one real published prefix in `models.tsv` — the full happy path,
against TLS, with the manifest exactly as shipped:

```
Added `hope` successfully.
sync: endpoint=https://sim-minio:9000 bucket=hope-models dest=/models
  syncing s3://hope-models/simmodel/q4km-012d6f4a4488  (role=llm)
`hope/hope-models/.../simmodel-Q4_K_M.gguf` -> `/models/staging/simmodel/simmodel-Q4_K_M.gguf`
`hope/hope-models/.../SHA256SUMS`          -> `/models/staging/simmodel/SHA256SUMS`
simmodel-Q4_K_M.gguf: OK
  verified simmodel/q4km-012d6f4a4488
sync: OK — staged and verified; sentinel written.
drwxr-sr-x 1 10001 10001 60 Aug 30 15:26 simmodel
```

That proves, end to end: `mc` over **HTTPS with verification disabled**
(`--insecure` on BOTH the `config host add` and the `mc mirror`, against a cert
no client trusts); the `https://` endpoint arriving from a non-optional
`configMapKeyRef`; the credential arriving from the `hope-models-reader` Secret;
`mc mirror`; `sha256sum -c` verification; the `.ready` sentinel; and correct
ownership on the PVC under `fsGroup: 10001`.

The `hope-models-reader` policy was exercised directly with the service account,
over the same TLS connection:

```
mc --insecure ls    reader/hope-models/            -> lists the published objects
mc --insecure cp    ... reader/hope-models/nope    -> Insufficient permissions
mc --insecure rm    reader/hope-models/...         -> Access Denied
mc --insecure ls    reader/recordings/             -> Access Denied
```

(TASK-832's lane measured the same policies independently and found the same
shape, plus that neither the reader nor the publisher holds `DeleteObject`.)

⚠️ **MinIO rejects an access key longer than 20 characters**
(`access key length should be between 3 and 20`) — measured while creating the
service account, worth knowing before you generate one.

### 7.3 NetworkPolicy — what was proven, and the caveat that matters

Ingress, against the shipped `hope-lmstudio-ingress` (peer set = `hope-text`
only, per the gateway ruling), using long-lived pods labelled as the real
callers:

```
BASELINE (no policy)            WITH hope-lmstudio-ingress
  sim-text            ALLOWED     sim-text            ALLOWED
  sim-harness         ALLOWED     sim-harness         BLOCKED
  sim-harness-worker  ALLOWED     sim-harness-worker  BLOCKED
  sim-nlp             ALLOWED     sim-nlp             BLOCKED
```

Those two `BLOCKED` harness rows are **OPEN-824-HARNESS made visible** (§4A):
the policy is doing exactly what the ruling says, and the two harness Deployments
are currently configured to do exactly what the ruling forbids. Close that before
the cutover, in the deployment repo, not by widening this rule.

Egress was also enforced (a DNS-only-policy pod timed out reaching a MinIO pod),
**but with a startup race**: a freshly-created pod reached a forbidden destination
at t=0 and was correctly blocked at t=45s, reproduced twice.

**This was a different CNI from k3s/flannel. It is evidence that the POLICY
EXPRESSES what it intends, not evidence that `hope-v2-dev` enforces it.** R-5 —
confirm k3s NetworkPolicy enforcement — remains OPEN, and the check is step 5' of
`lmstudio-service-cutover.yaml`. An unenforced ingress rule here means LM Studio is
completely unauthenticated to every pod in the namespace.

### 7.4 What could NOT be run, and why

| Item | Why |
|---|---|
| The LM Studio image | **Never built.** CI is the only builder (owner directive); no local build counts |
| vLLM anything | Needs a GPU and a ~10 GB image; the node has neither |
| vLLM's Run:ai streamer with verification disabled | Same — and it is worse than unproven, see OPEN-823-TLS in TASK-823 `config/vllm.env`: boto3 has **no env var** that disables verification, and Phase 2 MEASURED that exact shape failing `CERTIFICATE_VERIFY_FAILED`. `mc --insecure` has no vLLM equivalent |
| Anything about `10.10.1.102:9000` itself | The validating workstation is on `192.168.1.0/24`, not the `10.10.1.0/24` LAN, so it cannot reach the host at all. Everything above was proven against a stand-in MinIO with the same TLS shape |
