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
**both** the summarization path and the guardrail path. The new Service has the
same name. Applying it while the Deployment is at `replicas: 0` points
`hope-lmstudio` at nothing and breaks both — a failure that presents as an LLM
outage rather than as a networking change.

The seven-step order is in that file. The short version: **workload first,
models published, VRAM measured, scale to 1, verify the POD directly, and only
then the Service** — followed by deleting the two retired out-of-band files,
which is part of this ticket rather than later cleanup.

---

## 3. ROOT_CONFIG_REQUESTS — blocking, owner/orchestrator only

| # | Item | Why it blocks |
|---|---|---|
| **R-1** | **ConfigMap `arcaai-internal-ca`** (key `ca.crt`) in `hope-v2-dev` | MinIO's leaf is issued by the private "ARCAAI Internal CA". The sync Job fails closed (`CreateContainerConfigError`) without it, deliberately, rather than skipping TLS verification against a PHI object store. **TASK-823 and the llama.cpp lane need the identical ConfigMap** — creating it once unblocks all three. `kubectl -n hope-v2-dev create configmap arcaai-internal-ca --from-file=ca.crt=<path>` |
| **R-2** | **Secret `hope-models-reader`** (keys `accessKeyId`, `secretAccessKey`) | Least-privilege reader policy from `infrastructure/docker/minio/README.md` §4 — `ListBucket`/`GetObject`/`GetObjectVersion` on `hope-models` only, **no `DeleteObject`**. Never the root key, never the publisher key. Policy JSON is already committed at `infrastructure/docker/minio/policies/hope-models-reader.json`. |
| **R-3** | **Publish the models into `s3://hope-models/`, then fill `models.tsv`** | Two steps, and the second is easy to miss. **(a)** Publish per `infrastructure/docker/minio/README.md` §5.5 — that document owns the layout; this ticket only consumes it. **(b)** `<version>` is content-addressed (`<quant>-<sha256-12>` of `manifest.json`) and therefore unknowable until publication, so `models.tsv` ships `SET-AT-PUBLISH` placeholders and **the Job refuses to run until they are replaced**. |
| **R-4** | **Registry credentials + private-registry-only enforcement** | The image embeds a proprietary binary we hold no redistribution right to (§0 risk A-5, §5 L-2). `imagePullSecrets: hope-registry-creds` is on every pod spec here. Confirm the `lmstudio` repository is **not** mirrored anywhere public. |
| **R-5** | **Confirm k3s NetworkPolicy enforcement is on** (no `--disable-network-policy`) | Load-bearing here in a way it was not for llama.cpp: LM Studio has **no headless auth at all**, so the ingress policy is the *only* enforcement point (§5 L-1, risk A-4). A decorative policy is worse than none, because it looks like a control. |
| **R-6** | **Decide whether to add `LMS` to the release-tag grammar** | `<SVC>` is a closed set in `packages/utils/src/version-grammar.ts` (`ALL API ADMIN COMPAT GUARD HARNESS NLP TEXT STT TTS`). There is no LM Studio member, so `build-lmstudio` triggers on branch pushes and `ALL-` only — the same shape as `build-qdrant-init`. Adding `LMS-` edits `packages/**`, outside this lane's boundary. Workable as-is; raised so it is a decision rather than a gap. |
| **R-7** | **Verify (do not assume) the `AiProviderConnection` row** | See §5. Expected to be a **no-op**, which is exactly why it must be checked rather than skipped. |

---

## 4. What is deployed

| Object | Purpose |
|---|---|
| `hope-lmstudio-models` PVC (60Gi) | Warm, checksum-verified GGUF store. **Mounted read-WRITE by the serving pod** — see below |
| `hope-lmstudio-manifest` ConfigMap | `models.tsv` (what to sync), `imports.tsv` (how to publish + expected keys), `sync.sh` |
| `hope-lmstudio-model-sync` Job | PreSync/wave -1. MinIO → PVC staging, verify against the prefix's own `SHA256SUMS`, flip `.ready` |
| `hope-lmstudio` Deployment | `replicas: 0`. GPU, non-root, exec probes |
| 2 × NetworkPolicy | Ingress from `hope-text` only; egress DNS only |
| PDB + HPA | Inert, present for uniformity (§14.4 item 8) |
| `hope-lmstudio` Service | **In the cutover file, not here** |

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
