# hope-v2-dev — why hope-lmstudio / hope-mlflow / hope-vllm are at 0 replicas

Cluster `c-nfhxq` (k3s, single node `dell`), namespace `hope-v2-dev`.
Investigated 2026-09-01. READ-ONLY: nothing was patched, scaled or applied.

---

## A. VERDICT

All three Deployments are at zero because **Git says zero**. `deployment/k8s/base/{vllm,mlflow,lmstudio}.yaml`
in `arca/hope-v2-deployment@main` each declare `replicas: 0` with an explicit written
rationale; Argo CD applied exactly that (cause **(a)** — deliberately authored, not
(b) operator-scaled, not (c) manual drift, not (d) zeroed after the fact). The three
HPAs that would otherwise force `minReplicas: 1` are structurally inert, because the
Kubernetes HPA controller refuses to act on a zero-replica target
(`reason: ScalingDisabled`, `message: scaling is disabled since the replica count of the
target is zero`). So the zero is self-sustaining. Underneath that deliberate zero sit
**real unmet prerequisites that would make a naive scale-to-1 fail immediately**: the PVC
`hope-models-cache` and the Secret `hope-models-reader` do not exist in the cluster and are
in **no** kustomization (they live in `out-of-band/lmstudio-model-sync.yaml`, applied by
hand, which itself refuses to run while `models.tsv` still carries `SET-AT-PUBLISH`
placeholders); MLflow's `hope-secrets` keys and its `mlflow` database were never created;
and `hope-lmstudio` has **no Service and no Endpoints at all** in the live namespace.

---

## B. EVIDENCE TABLE

| | **hope-lmstudio** | **hope-mlflow** | **hope-vllm** |
|---|---|---|---|
| Live replicas | `spec.replicas: 0`, `generation: 1`, `deployment.kubernetes.io/revision: "1"` | same | same |
| Git-declared replicas | `replicas: 0` (base/lmstudio.yaml) | `replicas: 0` (base/mlflow.yaml) | `replicas: 0` (base/vllm.yaml) |
| Image (live) | `registry.taphuynh.dev/hope/lmstudio:dev` | `ghcr.io/mlflow/mlflow@sha256:2c9c50ca72e314cb1b8b301ceaa43882629ad91873d7271f3be92796930c3647` | `vllm/vllm-openai:v0.11.0` + `nginxinc/nginx-unprivileged:1.27-alpine` |
| Image real or placeholder? | **Path mismatch.** CI publishes to `$REGISTRY/$CI_PROJECT_PATH/lmstudio` (= `registry.taphuynh.dev/arca/hope-v2/lmstudio`, same shape as the live `registry.taphuynh.dev/arca/hope-v2/qdrant-init@sha256:…`). The manifest names `registry.taphuynh.dev/hope/lmstudio:dev`, and the dev overlay `images:` list has **no lmstudio entry** to rewrite it. Mutable `:dev` tag, not digest-pinned. | Real, digest-pinned by the overlay | Real public upstream tag |
| GPU request | `requests.nvidia.com/gpu: "1"` / `limits: "1"` | none | `requests.nvidia.com/gpu: "1"` / `limits: "1"` (on the `vllm` container only) |
| Service DNS | **NO SERVICE EXISTS.** Absent from the live namespace and from Argo's 26-Service desired state | `hope-mlflow.hope-v2-dev.svc.cluster.local:5000` → targetPort 5000, ClusterIP `10.43.230.22` | `hope-vllm.hope-v2-dev.svc.cluster.local:8000` → targetPort 8000, ClusterIP `10.43.232.159` |
| Ingress / IngressRoute | none | none (mlflow.yaml: *"NO INGRESS, deliberately (S-3)"*) | none |
| Last event of note | **No events at all** — `kubernetes_event_summary … since 26h` returned `No events found` for the whole namespace. Nothing has tried to schedule these pods. | same | same |

### Missing dependencies that would break a scale-to-1 today

| Object | Referenced by | Live? | In Argo desired state? |
|---|---|---|---|
| PVC `hope-models-cache` | lmstudio (`/data`, rw), vllm (`/models`, ro) | **NO** — live PVCs are `alertmanager-data`, `data-hope-qdrant-0`, `grafana-data`, `guardrail-hf-cache`, `hope-vault-data`, `loki-data`, `prometheus-data`, `tempo-data` | **NO** — Argo lists 7 PVCs, none named `hope-models-cache` |
| Secret `hope-models-reader` | vllm `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **NO** — live Secrets are `hope-minio-bootstrap`, `hope-registry-creds`, `hope-secrets`, `hope-vault-approle`, `hope-vault-init`, `hope-vault-unseal` | **NO** — Argo manages **zero** Secrets |
| Job `hope-lmstudio-model-sync` (writes `/models/.ready`) | lmstudio initContainer `await-models` blocks on it | **NO** — live Jobs are `hope-db-migrate`, `hope-qdrant-init`, `hope-smoke-test` | **NO** |
| Service + Endpoints `hope-lmstudio` (out-of-band, node-host backend) | `hope-text`, `hope-harness`, `hope-harness-worker` | **NO** — neither object exists | n/a (deliberately excluded) |

Both PVC and Job live in `deployment/k8s/out-of-band/lmstudio-model-sync.yaml`, whose own header states:
> *"It cannot succeed yet, by design: ROOT_CONFIG_REQUEST R-2 (Secret hope-models-reader) and R-3 (publish the models, fill models.tsv — it still carries SET-AT-PUBLISH placeholders) are both outstanding… `deployment/k8s/out-of-band/` is referenced by no kustomization, so Argo never renders, syncs or prunes this."*

`base/vllm.yaml` says the same:
> *"⚠️ THIS PVC IS CREATED OUT OF BAND, by `out-of-band/lmstudio-model-sync.yaml`, and it is NOT in any kustomization. It does not exist until an operator applies that file… It is NOT safe to scale this to 1 before the PVC exists and the sync has run."*

### Proof that nothing scaled these down after the fact

`kubernetes_describe deployment/hope-vllm` — `managedFields`, the only writer of `f:spec.f:replicas`:

```
"f:spec": { "f:replicas": {} , … }
"manager": "argocd-controller",
"operation": "Update",
"time": "2026-08-31T06:17:58Z"
```

There is no second manager touching `replicas` — no `kubectl`, no HPA, no operator. Combined with
`generation: 1` and `revision: "1"`, the Deployment has never been mutated since Argo created it.

`kubectl.kubernetes.io/last-applied-configuration` (all three) contains `"spec":{"replicas":0,…}` —
the applied manifest itself declared zero.

### Why the HPAs do not rescue it

All three HPAs are `minReplicas: 1, maxReplicas: 1`, Synced/Healthy, and all three report:

```
- reason: ScalingDisabled
  status: "False"
  type: ScalingActive
  message: scaling is disabled since the replica count of the target is zero
desiredReplicas: 0
```

This is documented HPA behaviour, and `base/lmstudio.yaml` says the HPAs are decorative anyway:
> *"Deliberately INERT (min == max), the same shape as stt.yaml's HPA and for the same reason: CPU-based autoscaling is wrong for a GPU pod, and there is exactly one GPU-capable node. Present for uniformity only."*

### Git rationale, verbatim

**lmstudio.yaml**
```
  # SHIPS AT ZERO, DELIBERATELY. Same posture as TASK-823's vllm.yaml.
  # LM Studio ALREADY RUNS ON THE NODE HOST and holds VRAM the k8s scheduler
  # cannot see. …
  # Scale to 1 ONLY after:
  #   1. reading actual free VRAM on the node …, AND
  #   2. stopping or accounting for the host LM Studio instance, AND
  #   3. completing the Service cutover in lmstudio-service-cutover.yaml.
  replicas: 0
```

**vllm.yaml**
```
# ⚠️ SHIPS AT `replicas: 0`. THIS IS A HARDWARE DECISION, NOT AN OVERSIGHT.
# This node's GPUs are 2x NVIDIA RTX 2000 Ada, 16380 MiB each
…
  # See the file header. Not a placeholder — a sizing verdict.
  replicas: 0
```

**mlflow.yaml**
```
  # 0, matching vllm.yaml and lmstudio.yaml — MLflow cannot start until an
  # operator has created its prerequisites (docs/mlflow-database.md): the
  # `mlflow` database on the platform TimescaleDB, its MinIO service account,
  # and the MLFLOW_* keys in Secret hope-secrets. Shipped at 1, the pod sat in
  # CreateContainerConfigError — "couldn't find key MLFLOW_MINIO_ACCESS_KEY in
  # Secret hope-v2-dev/hope-secrets" …
  replicas: 0
```

### Also note: the LM Studio Service is missing in *both* directions

`base/kustomization.yaml`:
> *"⚠️ NO SERVICE, DELIBERATELY. `hope-lmstudio` ALREADY EXISTS as the selector-less Service + hand-written Endpoints in ../out-of-band/, pointing at the node host, and it currently carries the summarization path (hope-text), the harness Institutional-RAG embeddings path, and the guardrail path indirectly through hope-text."*

**But that out-of-band Service is not applied either** — there is no `hope-lmstudio` Service and no
`hope-lmstudio` Endpoints in the live namespace. So the in-cluster DNS name `hope-lmstudio` that
`hope-text` / `hope-harness` / `hope-harness-worker` are documented to dial does not resolve today.
That is a live gap, not a staged one.

### Manifest-vs-comment drift found in the manifest repo

`base/kustomization.yaml` claims lmstudio.yaml *"Carries the PVC, the model manifest, the fail-closed
model-sync Job, three NetworkPolicies, an HPA and a PDB."* The actual file contains only: ConfigMap
`hope-lmstudio-manifest`, Deployment, NetworkPolicy `hope-lmstudio-ingress`, NetworkPolicy
`hope-lmstudio-egress`, PDB, HPA. **No PVC, no Job, only two NetworkPolicies.** The file's own egress
comment refers to *"the separate, narrower `hope-lmstudio-model-sync-egress` policy at the bottom of
this file"* — which is not present. Argo's rendered desired state confirms both absences.

Separately, `overlays/dev/kustomization.yaml` carries a de-hook patch targeting `kind: Job, name:
hope-mlflow-migrate`, but `mlflow-migrate.yaml` is in `out-of-band/` and is **not** a base resource,
so that patch matches nothing in the render (Argo's Job desired state is db-migrate / qdrant-init /
smoke-test only).

---

## C. GPU VERDICT — **YES, this cluster can schedule a GPU workload today**

The premise that the gpu-operator is "fully scaled to zero" is a **reporting artifact of the
`kubernetes_workload_health` MCP tool, not the cluster state.** That tool reports every gpu-operator
DaemonSet as `ready: 0, desired: 0, status: "ScaledToZero"`. The API object says otherwise:

`kubernetes_get daemonset/nvidia-device-plugin-daemonset -n gpu-operator`:
```
"status": {
  "currentNumberScheduled": 1,
  "desiredNumberScheduled": 1,
  "numberAvailable": 1,
  "numberReady": 1,
  "updatedNumberScheduled": 1
}
```

And the pods are Running: `nvidia-device-plugin-daemonset-qbmrz`, `gpu-feature-discovery-hmbfv`,
`nvidia-container-toolkit-daemonset-z9cjc`, `nvidia-dcgm-exporter-b8csw`,
`nvidia-operator-validator-cfb2x`, `nvidia-cuda-validator-cbsdw`, `gpu-operator-6c7cdb5d48-hvqrd`,
plus three node-feature-discovery pods. (Note: for the three *Deployments* the same tool's
`ScaledToZero` reading **is** correct — I verified `spec.replicas: 0` on the raw objects. Trust the
raw object, not the summary.)

Node `dell`, hard evidence:

```
capacity:      nvidia.com/gpu: "6"
allocatable:   nvidia.com/gpu: "6"
taints: []
```

Labels:
```
nvidia.com/gpu.present: "true"
nvidia.com/gpu.count: "2"
nvidia.com/gpu.product: NVIDIA-RTX-2000-Ada-Generation-SHARED
nvidia.com/gpu.memory: "16380"
nvidia.com/gpu.family: ada-lovelace
nvidia.com/gpu.replicas: "3"
nvidia.com/gpu.sharing-strategy: time-slicing
nvidia.com/gpu.deploy.driver: pre-installed
nvidia.com/cuda.driver-version.full: 590.48.01
nvidia.com/cuda.runtime-version.full: "13.1"
nvidia.com/mig.capable: "false"
nvidia.com/mps.capable: "false"
feature.node.kubernetes.io/pci-10de.present: "true"
```

- 2 physical RTX 2000 Ada × 3 time-slice replicas = **6 schedulable `nvidia.com/gpu` permits**.
- **No taints**, so a GPU pod needs no toleration.
- `nvidia-driver-daemonset` and `nvidia-mig-manager` genuinely have 0 pods, and correctly so:
  the driver is `pre-installed` on the host (label above) and the card is `mig.capable: "false"`.
- Already consumed: `management.cattle.io/pod-requests: '{…,"nvidia.com/gpu":"2",…}'` — **2 of 6
  permits are held by running pods, 4 free.** Both lmstudio and vllm request 1 each, so both fit
  *as scheduling units*.

**The real GPU constraint is VRAM, not schedulability.** A time-slice permit is fungible and carries
no memory isolation — `mig.capable: false`, `mps.capable: false`. TASK-823 §2A and the vllm.yaml
header call this out: 16380 MiB per card cannot hold an 8B-class model plus a useful KV cache, and
*"whichever CUDA context allocates last OOMs. On this node that casualty is very likely hope-stt — a
working production capability."* So: **vLLM can be scheduled today; whether it can serve usefully at
the 20–40-in-flight target is a separate, negative, hardware answer.** For day 1 the GGUF path
(LM Studio, `gemma-4-e2b-it-qat`, ~3.12 GiB + KV) is the option that actually fits this VRAM budget —
which is exactly what the LM Studio manifest is sized for.

---

## D. ARGO CD STATE

Single Application covering the namespace.

| Field | Value |
|---|---|
| name / namespace | `hope-v2-dev` / `argocd` |
| project | `hope-v2` |
| repoURL | `https://git.taphuynh.dev/arca/hope-v2-deployment.git` |
| path / targetRevision | `deployment/k8s/overlays/dev` / `main` |
| destination | `https://10.10.1.10:6443`, ns `hope-v2-dev` |
| **sync status** | **OutOfSync** (revision `bca2ab84fb95`) |
| **health** | **Missing** |
| syncPolicy | `{"automated": {}, "retry": {"limit":3,"backoff":{"duration":"5s","factor":2,"maxDuration":"3m"}}}` |
| **automated sync** | **ON** (`automated: {}` present) |
| **prune** | **OFF** (absent from `automated`) |
| **selfHeal** | **OFF** (absent from `automated`) |
| last operation | `phase: Succeeded`, `finishedAt: 2026-08-31T12:30:21Z`, `message: successfully synced (no more tasks)` |

Matches `.claude/rules/09-infrastructure-devops.md`: *"Argo CD auto-syncs `main`; `prune` and
`selfHeal` are currently **off**."*

**None of the three services is OutOfSync.** Across 128 tracked resources the counts are
`{('Synced','Healthy'): 90, ('Synced',''): 35, ('','Healthy'): 2, ('OutOfSync','Missing'): 1}`.
The single OutOfSync/Missing resource is `Job/hope-db-migrate` — a Job with
`ttlSecondsAfterFinished` that has been reaped, which is what drags the whole Application to
OutOfSync/Missing. It is unrelated to lmstudio/mlflow/vllm.

Every object belonging to the three services is `Synced` and, where it has a health type, `Healthy`:
Deployments ×3, Services ×2 (lmstudio has none), HPAs ×3, PDBs ×3, NetworkPolicies ×4, ConfigMaps ×5,
CronJob `hope-mlflow-gc`. **A zero-replica Deployment is reported Healthy by Argo** — the Deployment's
own status says `Available: True … MinimumReplicasAvailable / "Deployment has minimum availability."`
because 0 of 0 is satisfied. Argo health is therefore not evidence that anything is serving.

**Consequence of selfHeal=off + prune=off:** nothing in the cluster would undo a manual
`kubectl scale`, and nothing will delete the orphaned generation of ConfigMaps. It also means a
manual scale-to-1 would persist — and would then sit `Pending` on the missing PVC.

---

## E. CONFIG DRIFT — gateway-visible endpoint config

Secret **names** only (no values read; `showSensitiveData` never set):
`hope-minio-bootstrap`, `hope-registry-creds`, `hope-secrets`, `hope-vault-approle`,
`hope-vault-init`, `hope-vault-unseal`. Key names referenced by the manifests:
`hope-secrets/{MLFLOW_MINIO_ACCESS_KEY, MLFLOW_MINIO_SECRET_KEY, MLFLOW_BACKEND_STORE_URI,
DATABASE_URL, VAULT_ROLE_ID, VAULT_SECRET_ID, QDRANT_API_KEY}`; `hope-models-reader/{accessKeyId,
secretAccessKey}` (**Secret absent**); `hope-vault-init/root_token`.

### `hope-api-config-6629fmb499` — what the gateway resolves downstream URLs from

| Key | Value | Points at something that exists? |
|---|---|---|
| `TEXT_URL` | `http://hope-text:8862` | YES — Service + 1/1 pod |
| `STT_URL` | `http://hope-stt:8861` | YES |
| `NLP_URL` | `http://hope-nlp:8864` | YES |
| `GUARDRAIL_URL` | `http://hope-guardrail:8863` | YES |
| `HARNESS_URL` | `http://hope-harness:8866` | YES |
| `TTS_URL` | `http://hope-tts:8865` | YES |
| `MINIO_ENDPOINT` | `10.10.1.102:9000` | Off-cluster LAN host; reachability NOT verified from here — **UNKNOWN** |
| `MINIO_USE_SSL` | `"true"` | n/a |
| `ENABLE_PRISMA_STUDIO` | `"true"` | n/a |
| `OTEL_LOGS_ENABLED` / `OTEL_LOG_BRIDGE` | `"true"` | n/a |

**There is no `LM_STUDIO*`, `VLLM*` or `MLFLOW*` key anywhere in the gateway's config.** That is
correct by design, not drift: per `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers
and `base/kustomization.yaml`, *"Engine selection, model selection, base URL and credentials are
DB-tier (`AiProviderConnection` / `AiTaskDefault`)"*. The vLLM/LM Studio base URLs live in the
database, not in a ConfigMap — so a ConfigMap grep cannot confirm or deny them, and I did not query
the database. **The DB rows are UNKNOWN from this investigation.**

### `hope-platform-config-bm96hb992m`
`API_URL=http://hope-api:8868`, `AZURE_SPEECH_REGION=eastus`, `DEBUG=true`,
`DEPLOYMENT_ENVIRONMENT=dev`, `LOG_LEVEL=debug`, `NLP_PORT=8864`, `NODE_ENV=development`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317`, `OTEL_METRICS_ENABLED=true`,
`OTEL_TRACES_ENABLED=true`, `TTS_PORT=8865`. No AI-endpoint keys.

### `hope-text-config-5dttdkggff`
`TEXT_EXTERNAL_GUARDRAIL_BASE_URL=http://hope-guardrail:8863`,
`TEXT_GATEWAY_URL=http://hope-api:8868/api/v1`, `TEXT_LOG_LEVEL=info`. No LLM endpoint key.

### The three service-specific maps

| ConfigMap | Keys | Points at something that exists? |
|---|---|---|
| `hope-vllm-config-h58cf94bt6` | `VLLM_MODEL_URI=s3://hope-models/qwen3-4b-awq/v1/`, `VLLM_S3_ENDPOINT_URL=https://10.10.1.102:9000`, `VLLM_SERVED_MODEL_NAME=qwen3-4b-awq`, `VLLM_MAX_MODEL_LEN=4096`, `VLLM_GPU_MEMORY_UTILIZATION=0.50`, `VLLM_MAX_NUM_SEQS=8`, `VLLM_MAX_NUM_BATCHED_TOKENS=4096` | Bucket/prefix contents **UNKNOWN** (MinIO is off-cluster and was not queried). Note the mismatch of intent: this points at an **AWQ** prefix, while `hope-lmstudio-manifest`'s `models.tsv` lists only `-gguf` slugs and all four still read `SET-AT-PUBLISH`. |
| `hope-mlflow-config-gc7bkft25d` | `MLFLOW_S3_ENDPOINT_URL=https://10.10.1.102:9000` | UNKNOWN as above |
| `hope-lmstudio-config-h2b672g88m` | `LMSTUDIO_S3_ENDPOINT_URL=https://10.10.1.102:9000` | **Orphaned** — the `hope-lmstudio` Deployment has no `envFrom` and no `configMapKeyRef` pointing at this map. It is generated and synced but read by nothing. |

### Smoke test does not cover these services
`Job/hope-smoke-test` (PostSync, succeeded 2026-08-31T12:30:21Z) probes api, text, guardrail,
harness, nlp, tts, stt, admin-console, compat-playground. It does **not** probe mlflow, vllm or
lmstudio — so a green smoke test is not evidence about them.

---

## F. TICKET-vs-REALITY

| Ticket | Declared status | Contradicted by cluster? | Detail |
|---|---|---|---|
| **TASK-822** MLflow Deployment | `In Progress` — *"Phase 2 is committed and deployed …, `hope-mlflow` is live at `replicas: 0`, Synced/Healthy. … Scaling above 0 is gated only on operator steps, no hardware"* | **NO** | Exactly matches: Deployment live at 0, Synced/Healthy, Service + CronJob present, no Ingress. Accurate. |
| **TASK-823** vLLM Inference Service | `Pending` — *"manifests are now COMMITTED and deployed …; `hope-vllm` live at 0/0, Synced/Healthy, with this repo's first NetworkPolicies"* | **NO** on deployment state. **PARTIALLY** on the framing | Deployment/Service/HPA/PDB/2 NetworkPolicies all live and Synced. But the ticket's headline blocker is *"⚠️ Blocked on Hardware … enabling is an owner decision that needs a card in the A100/H100 class"*, which understates two nearer blockers the cluster shows: PVC `hope-models-cache` and Secret `hope-models-reader` do not exist, so scaling to 1 fails on volume/secret binding long before VRAM is the question. |
| **TASK-824** LM Studio Service | `In Progress` — *"manifests committed, `hope-lmstudio` live at `replicas: 0`; … Still blocked on R-2, R-3, R-5"* | **PARTIALLY** | Deployment live at 0 ✓, blockers R-2/R-3 confirmed ✓. Three contradictions: (1) `base/kustomization.yaml` says *"the image has never been built"* — **stale**: `build-lmstudio` job **15666 succeeded** and `verify-lmstudio-runtime` job **15667 succeeded** in pipeline **1048** (2026-08-31T19:47 +10:00, commit `e5ed9210`), and `promote-dev` job 15671 succeeded. (2) The manifest's image `registry.taphuynh.dev/hope/lmstudio:dev` is not the path CI publishes to (`$REGISTRY/$CI_PROJECT_PATH/lmstudio`), and the dev overlay `images:` list has **no lmstudio entry**, so no digest was written. (3) The ticket and kustomization both assume the out-of-band `hope-lmstudio` Service+Endpoints are **live** and *"currently carries the summarization path"* — **they do not exist in the namespace**. |
| **TASK-832** MinIO Internal Access & Model Bucket | `Review` — *"deployment-repo changes authored as handover and **still not applied**"* | **NO** | Consistent: `MINIO_ENDPOINT=10.10.1.102:9000` and the three `*_S3_ENDPOINT_URL` keys are internalized ✓, while Secret `hope-models-reader` (R-2) is still absent ✓ and `models.tsv` still reads `SET-AT-PUBLISH` (R-3) ✓. |
| **TASK-835** S3-Mounted Model Store | `Review` (research spike, `mountpoint-s3` CSI, simulated on OrbStack) | **NO** | Research spike; claims nothing about `c-nfhxq`. No `mountpoint-s3` CSI driver or related PV/PVC in the namespace, consistent with a spike that has not been adopted. |
| **TASK-836** MLflow Registry + vLLM Metal | `Review` (research spike, Apple-Silicon Metal path on an M3 Max) | **NO** | Research spike on a Mac; explicitly *"Metal is not reachable from a container"*. Says nothing about this cluster, and nothing in the cluster contradicts it. |

**Net:** no ticket claims `Completed`. The one materially stale claim is TASK-824 / the base
kustomization comment asserting the LM Studio image was never built — CI has since built and
verified it. The one materially *understated* item is that the live `hope-lmstudio` Service and
Endpoints, which several documents describe as carrying production traffic, are absent.

---

## G. THE MINIMUM SET OF ACTIONS (ordered; none performed)

Ordered so that each step's prerequisite is already satisfied. Steps 1–4 are the hard floor —
without them a scale-to-1 cannot bind volumes or secrets.

1. **[cluster-op]** Create MinIO service account + Secret `hope-models-reader`
   (`accessKeyId` / `secretAccessKey`) in `hope-v2-dev` — TASK-832 R-2. Required by
   `base/vllm.yaml` and by `out-of-band/lmstudio-model-sync.yaml`. Argo manages zero Secrets,
   so this is deliberately an operator step, not a Git change.
2. **[cluster-op]** Run `out-of-band/hope-models-publish.yaml` to publish the four model
   artifacts into `s3://hope-models/` and capture the content-addressed
   `<quant>-<sha256[0:12]>` versions it prints — TASK-832 R-3.
3. **[manifest-repo]** Paste those versions into the `models.tsv` block of the
   `hope-lmstudio-manifest` ConfigMap in `deployment/k8s/base/lmstudio.yaml`, replacing all four
   `SET-AT-PUBLISH` placeholders. Until this lands the sync Job fails closed by design.
4. **[cluster-op]** `kubectl -n hope-v2-dev apply -f deployment/k8s/out-of-band/lmstudio-model-sync.yaml`
   — this creates PVC `hope-models-cache` **and** runs the sync Job that writes `/models/.ready`.
   Confirm the Job succeeds before going further; the lmstudio `await-models` initContainer and
   the vllm `/models` mount both depend on it. Do **not** re-attach it as a PreSync hook.
5. **[manifest-repo]** Fix the LM Studio image reference: either add an `images:` entry to
   `overlays/dev/kustomization.yaml` mapping the manifest name to
   `registry.taphuynh.dev/arca/hope-v2/lmstudio` with the digest from pipeline 1048, or change
   `base/lmstudio.yaml`'s `image:` to the path CI publishes to. Also refresh the now-stale
   `base/kustomization.yaml` comment claiming the image was never built. **[ci]** Confirm
   `promote-dev` writes an lmstudio digest on the next run.
6. **[manifest-repo]** Reconcile the lmstudio.yaml drift: `base/kustomization.yaml` advertises a
   PVC, a model-sync Job and a third NetworkPolicy (`hope-lmstudio-model-sync-egress`) that the
   file does not contain. Either restore them or correct the comment — and note the file's own
   warning that the DNS-only egress policy selects the sync Job by label and would block its
   `mc mirror` on a NetworkPolicy-enforcing cluster.
7. **[cluster-op]** MLflow prerequisites: create the `mlflow` database on the platform
   TimescaleDB, its MinIO service account, and add `MLFLOW_MINIO_ACCESS_KEY`,
   `MLFLOW_MINIO_SECRET_KEY`, `MLFLOW_BACKEND_STORE_URI` to Secret `hope-secrets`; then run
   `out-of-band/mlflow-migrate.yaml`. Verify `hope-secrets` carries those keys **before**
   scaling, or the pod returns to `CreateContainerConfigError`.
8. **[manifest-repo]** Set `hope-mlflow` `replicas: 1`. Lowest risk of the three: no GPU, no PVC,
   1 CPU / 1 GiB. Verify `GET http://hope-mlflow:5000/health` from an in-cluster pod. (Argo
   automated sync is ON, so the commit alone rolls it; a `kubectl scale` would work too but is a
   live-cluster edit the rules forbid.)
9. **[cluster-op]** Measure real free VRAM on `dell` (`nvidia-smi --query-gpu=memory.used,memory.total
   --format=csv`) and account for the host LM Studio instance, which holds VRAM the scheduler
   cannot see. This is the gate the vllm.yaml and lmstudio.yaml headers both name.
10. **[manifest-repo]** Set `hope-lmstudio` `replicas: 1` (the GGUF tier that fits 16 GiB; vLLM
    does not). Verify the pod directly by IP/port — not through a Service, which does not exist
    yet — then prove the NetworkPolicy peer set (`hope-text`, `hope-harness`,
    `hope-harness-worker`) still reaches port 1234.
11. **[manifest-repo]** Only then, the Service cutover: land the `hope-lmstudio` Service so the
    name resolves to the in-cluster pod. Note the file `lmstudio-service-cutover.yaml` referenced
    by the manifests **does not exist** in `out-of-band/` (which holds `lmstudio-service.yaml` and
    `lmstudio-endpoints.yaml` instead) — that gap must be resolved before this step is actionable.
    Since neither the Service nor the Endpoints are currently applied, this is a
    create, not a live replacement, so the outage risk the manifests warn about is lower than
    documented — but confirm that before relying on it.
12. **[manifest-repo]** vLLM last, and only as a deliberate owner decision: it needs
    `OPEN-823-TLS` resolved (publicly-trusted cert on the MinIO listener, since
    `RUNAI_STREAMER_S3_VERIFY_SSL=0` covers only the Run:ai client, not boto3), and its
    `VLLM_MODEL_URI` points at an **AWQ** prefix that step 2 must actually publish — `models.tsv`
    currently lists GGUF only. Expect it to schedule (4 GPU permits free) but to contend for
    VRAM with `hope-stt`.
13. **[manifest-repo]** Housekeeping, independent of the above: remove or relocate the dead
    `hope-mlflow-migrate` patch in `overlays/dev/kustomization.yaml` (targets a Job that is not a
    base resource), and decide whether `hope-lmstudio-config` should be consumed by the
    Deployment or dropped — it is currently generated, synced, and read by nothing.

### Explicitly NOT recommended
- No local container build (project rule: GitLab CI is the only builder). The images that matter
  are already built by pipeline 1048.
- No `kubectl scale` as the durable fix. With `selfHeal: false` it would stick, but it puts the
  cluster ahead of Git and the next Argo sync of that file would revert it. Replica count is a
  manifest-repo change.
- Do not turn on Argo `prune`/`selfHeal` as part of this work — that is TASK-616 E6 steps 8–9,
  in that order, and flipping selfHeal now would fight any interim manual scaling.

---

## Unknowns (not guessed)
- Contents of `s3://hope-models/` and whether `qwen3-4b-awq/v1/` exists — MinIO at `10.10.1.102:9000`
  is off-cluster and was not queried.
- Whether `hope-secrets` currently holds the `MLFLOW_*` keys — Secret values were deliberately not read.
- Whether the `AiProviderConnection` / `AiTaskDefault` rows point at `http://hope-lmstudio:1234/v1`
  or at a vLLM/MLflow URL — that is DB-tier config and the database was not queried.
- Whether k3s is actually enforcing NetworkPolicy on this cluster (`base/vllm.yaml` flags this as
  unverified: *"⚠️ MUST VERIFY BEFORE TRUSTING THIS"*).
- Which specific pods hold the 2 already-requested GPU permits — the node annotation gives the
  total (`nvidia.com/gpu: "2"`), not the per-pod attribution.
