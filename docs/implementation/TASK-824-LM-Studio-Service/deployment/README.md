# TASK-824 — deployment handover (STAGED, NOT APPLIED)

Nothing here has been applied to a cluster, and nothing has been committed to
`hope-v2-deployment`. **The orchestrator makes every commit to that repo**
(EXECUTION-PLAN §14.5).

## 1. Files to copy

| From (this directory) | To (`hope-v2-deployment`) |
|---|---|
| `llama-cpp.yaml` | `deployment/k8s/base/llama-cpp.yaml` |
| `model-sync.yaml` | `deployment/k8s/base/llama-cpp-models.yaml` |
| `config/llama-cpp.env` | `deployment/k8s/base/config/llama-cpp.env` |

Then, per EXECUTION-PLAN §14.4:

1. Register both in `base/kustomization.yaml` `resources:` **with a comment saying why**.
2. Add `config/llama-cpp.env` as a `configMapGenerator` producing `hope-llama-cpp-config`.
3. Add `newName` + `digest` for `registry.taphuynh.dev/hope/llama-cpp` to
   `overlays/dev/kustomization.yaml` `images:`. Never hand-edit staging/prod — the
   app repo's `promote-*` jobs write those.
4. `kustomize build deployment/k8s/overlays/dev` locally before pushing.

`verify-manifest.py` and `../image/verify-build-floor.py` stay in **this** repo —
they are verification tooling, not manifests.

## 2. What is deployed

| Object | Purpose |
|---|---|
| `hope-llama-models` PVC (40Gi) | Warm, checksum-verified GGUF store |
| `hope-llama-model-manifest` ConfigMap | `models.tsv` (what to sync), `upstream.json` (provenance record), `sync.sh` |
| `hope-llama-model-sync` Job | PreSync/wave -1. MinIO → PVC, verify against the prefix's `SHA256SUMS`, flip `.ready` |

> **This ticket does NOT define the bucket layout.** TASK-832 landed mid-lane and made
> `infrastructure/docker/minio/README.md` authoritative for `hope-models` in every
> environment. An earlier draft here carried its own `<publisher>/<repo>/<quant>/`
> keys, inherited from TASK-824 §3.1 — a shape chosen because *LM Studio* resolves
> models from a `<publisher>/<model>/` tree. That constraint died with the engine
> recommendation. The manifests now consume `<slug>/<version>/` and verify against
> each prefix's own `SHA256SUMS`, so digests are **not** duplicated into this repo.
| `hope-llama-presets` ConfigMap | Router presets — one section per chat model |
| `hope-llama-cpp` Deployment + Service | Chat plane, router mode, 3 models, GPU |
| `hope-llama-embed` Deployment + Service | Embedding plane, single-model, GPU |
| 4 × NetworkPolicy | Ingress from `hope-text`/`prometheus`; egress DNS only |
| 2 × HPA, 2 × PDB | Inert, present for uniformity (§14.4 item 8) |

**Both Deployments ship at `replicas: 0`**, the same posture as TASK-823's
`vllm.yaml`, and for the reason TASK-831 §6.4 states in its own caveats: the
per-card placement plan is *not enforceable* under time-slicing, and real free
VRAM has never been measured because the host LM Studio instance sits outside
k8s accounting. Scale to 1 only after reading `nvidia-smi` on the node.

## 3. ROOT_CONFIG_REQUESTS — blocking, owner/orchestrator only

| # | Item | Why it blocks |
|---|---|---|
| R-1 | **ConfigMap `arcaai-internal-ca`** (key `ca.crt`) in `hope-v2-dev` | MinIO's leaf cert is issued by the private "ARCAAI Internal CA". The sync Job fails closed (`CreateContainerConfigError`) without it, deliberately, rather than skipping TLS verification against the object store. **TASK-823 requires the identical ConfigMap and is blocked on the same thing** — creating it once unblocks both. `kubectl -n hope-v2-dev create configmap arcaai-internal-ca --from-file=ca.crt=<path>` |
| R-2 | **Secret `hope-llama-api-key`** (key `api-key`) | Consumed via `--api-key-file`. This is the control §5 L-1 said could not exist at all under LM Studio ("grepping `lms/src` for `apiToken\|requireAuth\|createToken\|bearer` returns zero hits"). With llama-server it is real, so the NetworkPolicy goes back to being defence in depth instead of the sole enforcement point. `apps/text` must send the same value as its connection `apiKey`. |
| R-3 | **Publish the four models into `s3://hope-models/`, then fill `models.tsv`** | Two steps, and the second is easy to miss. **(a)** Publish each model per `infrastructure/docker/minio/README.md` §5.5 — that repo owns the layout, this ticket only consumes it. `deployment/verify-manifest.py --remote` performs §5.5 step 0 (verify against the publisher) for all four models in one command. **(b)** The prefix `<version>` is **content-addressed** (`<quant>-<sha256-12>` of `manifest.json`) and therefore unknowable until publication, so `models.tsv` ships with `SET-AT-PUBLISH` placeholders and **the Job refuses to run until they are replaced** — verified. §3.1b's choice (mirror rather than let the pod reach `huggingface.co`) is what lets the egress NetworkPolicy be DNS-only. |
| R-3b | **Secret `hope-models-reader`** (keys `accessKeyId`, `secretAccessKey`) | The sync Job uses the least-privilege reader policy from `minio/README.md` §4 (`ListBucket`/`GetObject`/`GetObjectVersion` on `hope-models` only, **no `DeleteObject`**), never the root key and never the publisher key. Policy JSON is already committed at `infrastructure/docker/minio/policies/hope-models-reader.json`. |
| R-4 | **Seed rows** — see §5 below | Nothing routes without them. |
| R-5 | **Confirm k3s NetworkPolicy enforcement is on** (no `--disable-network-policy`) | TASK-823 flagged this; here it is load-bearing rather than cosmetic. A decorative policy is worse than none. |

## 4. Verification actually performed

Run from this repo, no cluster required:

```
python3 docs/implementation/TASK-824-LM-Studio-Service/image/verify-build-floor.py
python3 docs/implementation/TASK-824-LM-Studio-Service/deployment/verify-manifest.py --remote
```

Both pass today. Their output is pasted in the ticket README §2A/§10.

What was **not** possible here: any GPU execution. This work was done on an
arm64 Mac with no NVIDIA device. Everything below was proven on the **CPU**
image, which is the same binary and the same build (`b9853`,
`7af4279f4579094cbe121cccb3c28357396e55d0`) as the CUDA image:

- the image builds, runs non-root, and its boot assertions fire (exit 78);
- `/health`, `/v1/models`, `/v1/embeddings`, `/props`, `/metrics` all serve;
- `/health` is a real readiness gate: **503 `{"error":{"message":"Loading model"}}`
  at t+0.02s → 200 `{"status":"ok"}` at t+1.68s** on a cold 3.12 GiB load;
- `--mmproj` activates **vision AND audio** (`/props` → `modalities` all true),
  and its absence leaves the same model text-only — `-m` does not auto-pair;
- a **real vision inference** on a known-answer image returned the right answer;
- router mode parses presets, and a model autoloads on first request;
- `sync.sh` runs unmodified in `minio/mc` against a live MinIO on the
  `<slug>/<version>/` layout, and **fails closed in all three negative cases** —
  corrupted `SHA256SUMS`, missing `SHA256SUMS`, and an unfilled version
  placeholder each give exit 1 with no `.ready` written.

**GPU offload itself is unproven and is the first thing to check on the node.**
Per §4.1 that was the highest-probability failure of the *original* design; it
is structurally absent here (the accelerator is in the tag and the digest, not
inferred from the build host), but "structurally absent" is an argument, not a
measurement.

## 5. Seed rows required (`AiProviderConnection`) — SPEC ONLY

I did not touch `packages/**`. These are specifications for the orchestrator.

### 5.1 Chat plane — MODIFY the existing row, do not add one

The table is `@@unique([tenantId, service, provider])`, so `('SYSTEM','llm','lm-studio')`
already exists and can only be **repointed**:

```ts
// packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:238
{
  id: '87000000-0000-0000-0000-000000000002',
  tenantId: SYSTEM_TENANT_ID,
  service: 'llm',
  provider: 'lm-studio',
- baseUrl: 'http://localhost:1234/v1',
+ // llama-server's OpenAI-compatible wire. The provider NAME stays 'lm-studio'
+ // because that is what selects the openai_compat adapter
+ // (`_LM_STUDIO_PROVIDER_NAMES`), which is the adapter that applies the chat
+ // template and can carry image/audio content parts.
+ baseUrl: 'http://hope-llama-cpp:8080/v1',
  ...
}
```

**Keep `provider: 'lm-studio'` on the four `AiModel` rows too.** This looks
wrong and is not:

> In the catalogue, `provider: 'llama-cpp'` does **not** mean "served by
> llama.cpp". It selects `LlamaCppProvider`, which posts to the **native
> `/completion`** endpoint — a raw-prompt client (`providers/llama_cpp.py:79
> `_build_prompt`) that applies no chat template and cannot express image or
> audio content parts. Tagging a Gemma 4 IT multimodal model `llama-cpp` loses
> the chat template *silently* and both modalities *loudly*.

The trailing `/v1` matters: `openai_compat` needs it, and the existing
`llama-cpp` row deliberately omits it because `/completion` hangs off the root.

### 5.2 Model rows — `sourceUri` must equal a preset section name

`resolveTextSelectionForKey` returns `model: model.sourceUri` and that string
goes on the wire as the OpenAI `model` field. The router dispatches on it. A
mismatch 404s every generation (TASK-831 §7.4). Current `sourceUri` values
already match the preset section names in `llama-cpp.yaml`:

| `AiModel` slug | `sourceUri` | preset section | matches |
|---|---|---|---|
| `lms-gemma-4-e2b-it-qat` | `gemma-4-e2b-it-qat` | `[gemma-4-e2b-it-qat]` | ✅ |
| `lms-gemma-4-e4b-it-qat` | `gemma-4-e4b-it-qat` | `[gemma-4-e4b-it-qat]` | ✅ |
| `granite-guardian-4.1-8b` | `granite-guardian-4.1-8b` | `[granite-guardian-4.1-8b]` | ✅ |

That alignment is deliberate — the preset names were chosen to fit the
catalogue, so **no `AiModel` row needs its `sourceUri` changed**. Still
outstanding from TASK-831 §7.1, and unchanged by this ticket:

- `lms-gemma-4-e2b-it-qat.memorySizeMb` 2048 → **4136** (understated ~64%)
- `lms-gemma-4-e4b-it-qat.memorySizeMb` 3072 → **5858** (understated ~68%)
- `granite-guardian-4.1-8b.computeType` says `q4_k_s`; the staged file is
  **Q4_K_M**. Q4_K_S is a different blob (4.53 GiB, sha `f713dd82…`).
  Reconcile the row to whichever is actually synced.

### 5.3 Embedding plane — SPEC ONLY, and it does not route yet

```ts
{
  id: '87000000-0000-0000-0000-00000000000c',   // next free in the block
  tenantId: SYSTEM_TENANT_ID,
  service: 'embeddings',
  provider: 'llama-cpp',
  baseUrl: 'http://hope-llama-embed:8080/v1',
  region: null, apiVersion: null, deploymentName: null,
  encryptedApiKey: null, keyVersion: null,
  apiKeyPlaintext: SELF_HOST_PLACEHOLDER_API_KEY,
  enabled: true,
  metaData: { note: 'llama-server --embeddings. TEI cannot load the GGUF (safetensors/ONNX only).' },
}
```

> ⚠️ **This row cannot work on its own.** `apps/text` registers exactly one
> embedding provider — `tei-embed` (`main.py:191-194`). There is no
> `llama-cpp` embeddings factory, so the row would resolve to nothing. Closing
> this needs an `apps/text/src/**` change, which this ticket is forbidden to
> make, and it is **TASK-831 §9 owner decision 2** — (a) add a llama.cpp
> embeddings provider and honour "all GGUF", or (b) keep TEI on the
> **safetensors** checkpoint and drop the GGUF for embeddings.
>
> Also verify `'embeddings'` is a member of `SeedableProviderService` before
> writing the row; I did not modify or read that type's full definition.

Two caller-side traps from TASK-831 §5.1 that no engine fixes, and which the
row's `note` should carry into the console:

1. **Task prefixes are mandatory and no engine applies them.** Queries need
   `task: search result | query: {content}`, documents `title: none | text: {content}`.
   Omitting them does not error — it silently degrades retrieval.
2. **Matryoshka truncation is caller-side.** Slicing 768→512/256/128 requires
   re-normalizing. *(Measured: llama-server returns unit-norm vectors at full
   width — L2 = 1.000000 — so the full-width case needs nothing, but any
   truncation still does.)*

## 6. Fallback if router mode is judged unacceptable

llama-server prints at every startup:

```
NOTE: router mode is experimental
      it is not recommended to use this mode in untrusted environments
```

This is recorded rather than buried. If the owner rejects an experimental code
path on the PHI plane, the fallback costs **one chat model, not a redesign**:

1. Run `hope-llama-cpp` in plain single-model mode (`--model` + `--mmproj` +
   `--alias`), exactly like `hope-llama-embed` already does.
2. That endpoint serves **one** chat model, because `('SYSTEM','llm','lm-studio')`
   is a single baseUrl.
3. A second chat model can be added by reusing `('SYSTEM','llm','llama-cpp')`
   — but **only for a text-only model**, since that provider name selects the
   raw-prompt `/completion` adapter. Granite Guardian qualifies; the Gemma 4
   pair does not.
4. So the honest fallback ceiling is: **one Gemma 4 + Granite Guardian**, with
   the second Gemma model unreachable until either a provider name is added in
   `packages/**` or router mode is accepted.

The single-model path is otherwise strictly better-understood: `/health` alone
is both liveness and readiness, and nothing is experimental.
