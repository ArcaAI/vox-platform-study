# TASK-690 — AWS Deployment Architecture & GitHub Actions Migration

| Field | Value |
|---|---|
| **Status** | `Pending` — solution design, no code written |
| **Type** | `infrastructure` |
| **Ticket number** | **PROVISIONAL.** Assigned as next-after-TASK-689; confirm against `docs/implementation/` + `docs/archive/` before this doc is treated as canonical. |
| **Region** | `ap-south-1` (Mumbai) |
| **Target scale** | Pilot — 1–5 tenants, < 50 concurrent consultations |
| **Service window** | 06:00–20:00 IST (14 h/day = 58 % duty cycle) |
| **Hard constraints** | Monthly budget ceiling (**number not yet supplied**) + zero-downtime/SLA |
| **Evidence base** | Four parallel audits, 2026-08-13: monorepo runtime inventory, `hope-v2-deployment` manifest audit, GitLab CI audit, AWS ap-south-1 pricing research |

---

## 0. The four findings that shaped everything else

Before the architecture, the four discoveries that changed the answer:

1. **Only ONE service actually needs a GPU.** STT (`hope-stt-v2` + `hope-stt-v2-worker`) is the sole CUDA consumer. NLP deliberately excludes the CUDA stack (TASK-647), TTS is CPU-pinned torch, guardrail is ONNX-CPU + llama.cpp CPU, SMR holds no local model at all. The GPU bill is therefore **one instance family, not a fleet** — this is the single biggest cost fact in the design.

2. **The budget ceiling and the zero-downtime requirement are in direct conflict, and the resolution is a scoping decision, not an engineering one.** Zero-downtime *inside the 06:00–20:00 service window* is affordable. Zero-downtime *24/7* forbids the scale-to-zero that makes a 14-hour duty cycle worth having, and doubles the GPU line. **This design commits to: zero-downtime during service hours; 20:00–06:00 is a declared maintenance window.** If that is wrong, say so — it changes the number by roughly $500/month.

3. **The single-GPU-node SPOF has a nearly free fix you already built.** A hot-standby GPU node costs ~$515/month. But your STT service already has a provider abstraction with automatic fallback (TASK-614), and Amazon Transcribe streaming supports both `ml-IN` and `en-IN` in ap-south-1. Registering Transcribe as the failover provider buys zero-downtime on the clinical path for *only what an incident consumes*, instead of a permanently-idle second A10G.

4. **Roughly 40 % of the migration cost is paying down debt the audits found, not moving to AWS.** Node-local `hostPath` model caches, a single-node Shamir-sealed Vault with unseal keys stored in the cluster it protects, no ingress and no TLS anywhere, no StorageClass, `minAvailable: 0` on every PDB, an unprobed STT worker, two Temporal deployments of which the live one is a VM outside Kubernetes, and 15 container images rebuilt on every single push regardless of what changed. These are pre-existing defects. AWS does not fix them, but the migration is the natural forcing function.

---

## 1. Requirement Analysis

### 1.1 What is being deployed

From the runtime inventory — **13 long-running workloads + 3 jobs**:

| Workload | Runtime | GPU | Stateful? | Notes |
|---|---|---|---|---|
| `hope-api` | Node 24 / NestJS, :8868 | no | connection-stateful | 3 WS gateways + 9 SSE routes; **WS resume state is a per-process in-memory Map** — no cross-pod resume. Also hosts 10 in-process BullMQ processors. |
| `hope-admin-console` | Node 24 / Next.js standalone, :3000 | no | no | BFF, SSE passthrough |
| `hope-compat-playground` | static SPA via `serve` | no | no | |
| `hope-smr` | Python/FastAPI, :8862 | no | no | Pure LLM gateway, **no local model** |
| `hope-guardrail` | Python/FastAPI, :8863 | no | own DB conn | GLiNER ONNX CPU + llama.cpp CPU; sanctioned direct-Postgres exception |
| `hope-nlp` | Python/FastAPI, :8864 | **no, by design** | no | CUDA stack explicitly excluded from image (TASK-647) |
| `hope-harness` | Python/FastAPI, :8866 | no | no | Best-effort Temporal connect; must boot without it |
| `hope-harness-worker` | Python / Temporal worker | no | no | Heaviest non-GPU: 1 CPU / 2 Gi requested, 4 CPU / 6 Gi limit |
| `hope-tts` | Python/FastAPI, :8865 | no | no | CPU-pinned torch (1.39 GB vs 7.34 GB unpinned); Kokoro ~327 MB fetched at runtime. **Peak RSS scales with concurrency, not audio length** — 7.2 GB at N=5 pre-fix. |
| `hope-stt-v2` | Python/FastAPI, :8861 | **YES** | Redis session state | CUDA 12.8; startup probe allows **up to 15 min** |
| `hope-stt-v2-worker` | Dramatiq worker | **YES** | no | **Zero probes of any kind** — a wedged worker is never restarted |
| `hope-qdrant` | Qdrant v1.16 StatefulSet | no | **PVC** | `knowledge_chunks`, 1024-dim (bge-m3) |
| `hope-vault` | Vault 1.18.3 StatefulSet | no | **PVC** | Single node, Shamir, **no resource requests at all** |
| `hope-temporal` (+UI) | auto-setup 1.25.1 | no | external DB | **Dead code** — live Temporal is a VM at `10.10.1.10:7233` |
| Jobs | `db-migrate` (PreSync), `qdrant-init` (Sync w1), `smoke-test` (PostSync w5) | | | |

Plus an in-cluster observability stack: Prometheus, Grafana, Loki, Tempo, Alertmanager, OTel Collector, Alloy (DaemonSet), kube-state-metrics, node-exporter (DaemonSet).

### 1.2 Current operational baseline

One node named `dell`: **16 vCPU, 48 GB RAM, 2× RTX 2000 Ada (16 GB each), ~93 GB ephemeral**, sitting at ~15/16 CPU and 44/48 GB *requested*. Real data volume: 33 users, 14 consultations, 1,255 audit rows. Only `hope-v2-dev` exists; staging and prod namespaces are defined in Git but have never been created.

This matters for sizing: the resource **requests** are calibrated to keep pods scheduled on one box, not to measured load. Do not port them to AWS verbatim and then buy hardware to match — they are ceilings, not demand.

### 1.3 PHI classification (drives BAA scope and encryption)

| Holds PHI | Metadata only |
|---|---|
| Postgres `core` schema — `Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `TranscriptSegment`, `TranscriptionJob` | Redis (persistence deliberately disabled) |
| `UserVoiceProfile.embedding` — pgvector 256-dim biometric voiceprint, **deliberately unencrypted** for cosine similarity | Prometheus / Grafana / Loki / Tempo |
| S3 buckets `recordings`, `generated-audio`, `hope-audio`, `hope-audio-chunks` | Qdrant `knowledge_chunks` (reference corpus, not patient data) |
| Vault (holds the keys, not the data) | Temporal visibility DB (workflow IDs, not transcripts) |

---

## 2. Decision 1 — Inference: self-host GPU vs SageMaker vs Lambda

You asked directly which is best. **Self-host on an EKS GPU node, with Amazon Transcribe registered as the failover provider.** Here is why the alternatives lose.

### 2.1 The comparison

| Option | Verdict | Pilot cost/mo | Why |
|---|---|---|---|
| **Self-host on EKS GPU** (`g5.xlarge`, 14 h/day) | ✅ **Recommended** | **~$515** | Keeps your fine-tuned ml-en GGUF/CTranslate2 models. Your STT service ships as-is. Karpenter gives real scale-to-zero. |
| **SageMaker real-time endpoint** (`ml.g5.xlarge`) | ❌ | ~$700+ | Two independent blockers. (a) SageMaker adds a premium over the equivalent EC2 rate and real-time endpoints **do not scale to zero** — you pay 24/7 for a 14-hour workload, which is exactly backwards for your duty cycle. (b) More fundamental: **your STT service is not a model server.** It is a stateful FastAPI app doing VAD → ASR → diarization → punctuation, holding WebSocket sessions and Redis Streams state with a 500 MB/session audio buffer and a 15 s reconnect grace window. SageMaker endpoints serve stateless request/response. You would have to split the model out of the service and rebuild the session layer around it. |
| **SageMaker Serverless Inference** | ❌ | — | **CPU only. No GPU option exists.** Disqualified outright. |
| **SageMaker Async Inference** | ⚠️ Partial fit | scale-to-zero | Genuinely good for the **Dramatiq batch transcription queue** — async, queue-driven, scales to zero between jobs. Useless for live streaming. Worth considering later to move batch off the live GPU node; not for the pilot. |
| **AWS Lambda** | ❌ | — | Four hard blockers: no GPU at any memory tier; 15-minute execution cap against ~87-minute session support; 10 GB memory cap against a 3.5 GB model plus audio buffers; and no persistent WebSocket — streaming ASR is inherently connection-stateful. Lambda is appropriate for `db-migrate`/`qdrant-init`-shaped one-shot jobs, not for models. |
| **Amazon Transcribe streaming** | ⚠️ Failover role | ~$0.024/min | `ml-IN` and `en-IN` are both supported for streaming in ap-south-1 (ap-south-1 is *not* on the streaming exclusion list). But it has no Malayalam–English **code-switch** fine-tune — which was the entire point of TASK-594. Using it as primary is a quality regression on your core clinical case. |

### 2.2 The break-even you should know

```
g5.xlarge @ 14 h/day  = $1.208/hr × 426 hr/mo  = $515/mo
Transcribe streaming  = ~$0.024/min  (⚠ us-east-1-derived; verify the ap-south-1 rate)

Break-even = $515 ÷ $0.024 ≈ 21,500 min/month
           ≈ 715 min/day
           ≈ 36 twenty-minute consultations per day
```

**Below ~36 consultations/day, Transcribe is cheaper than owning a GPU.** At 14 consultations total in the dev DB today, you are far below that line — so on pure cost, Transcribe wins the pilot.

It still loses, because the ml-en code-switch fine-tune is a clinical-quality requirement, not a cost line. But this number tells you exactly when the GPU starts paying for itself, and it is the number to revisit if pilot volume stays low.

### 2.3 Recommended inference topology

| Capability | Placement | Rationale |
|---|---|---|
| **ASR (live)** | Self-hosted, EKS GPU node, `g5.xlarge` | Fine-tuned ml-en model; no managed equivalent |
| **ASR (failover)** | Amazon Transcribe streaming, `ml-IN`/`en-IN` | Registered as a provider in the existing auto-fallback (TASK-614). Costs nothing until an incident. **This is what buys zero-downtime without a second GPU.** |
| **ASR (batch)** | Same GPU node initially; SageMaker Async later | Dramatiq queue tolerates latency |
| **LLM summarization** | **Bedrock** — see governance flag below | SMR already has a Bedrock provider. At pilot volume, per-token beats a dedicated GPU by a wide margin. |
| **TTS (English)** | Kokoro, CPU, on Graviton | Already CPU-only. No GPU needed. Cap concurrency — RSS scales with parallel synths, not audio length. |
| **TTS (Malayalam)** | Sarvam (current) — evaluate Polly | Polly has Hindi + Indian English via the bilingual Kajal voice; **a Malayalam voice is not confirmed.** Verify before planning a migration. |
| **NER / guardrail / reranker** | CPU on Graviton | Already CPU-only by design |

> ### 🚩 Governance flag — Bedrock + Claude in India routes data OUT of India
> Models hosted **natively** in ap-south-1 are Mistral, Gemma, and MiniMax. Claude and Nova reach Indian customers through **Global Cross-Region Inference (CRIS)** (`global.anthropic.claude-*`), which by definition routes inference outside the region.
>
> You did not select "all PHI stays in India" as a hard constraint, so this design does not forbid it. But for a healthcare platform that may become ABDM/HRP-registered — where India-residency *is* the operative requirement — sending clinical text to a cross-region endpoint is a decision that needs an explicit, recorded owner sign-off, not a default. **If residency is required: use an ap-south-1-native Bedrock model, or self-host the summarization LLM on the same GPU node during off-peak.**

---

## 3. Decision 2 — Orchestration substrate

You asked for a matrix with cost. Sized against the pilot footprint below.

### 3.1 Pilot footprint (derived from actual manifest requests)

| Tier | vCPU | Memory | Notes |
|---|---|---|---|
| App workloads (9, `hope-api` ×2 for HA) | 3.8 | 6.8 Gi | |
| In-cluster stateful (Qdrant, Vault) | 0.75 | 1.5 Gi | Vault has no requests today — 250m/512Mi assigned |
| Temporal + UI | 0.35 | 0.6 Gi | |
| Observability stack | 1.17 | 2.1 Gi | |
| **Non-GPU subtotal** | **~6.1** | **~11.5 Gi** | plus ~0.5 vCPU / 1 Gi per node for EKS system DaemonSets |
| GPU tier (STT ×2) | 4.0 | 16 Gi | + 1 GPU (time-sliced across both pods) |

For N+1 (survive one node loss with no pending pods): **3 × `m7g.xlarge`** = 12 vCPU / 48 GiB across 3 AZs. After losing one node: 8 vCPU / 32 GiB, still ≥ the 6.1/11.5 requirement.

### 3.2 The matrix

| | **EKS + Karpenter** | **EKS Auto Mode** | **ECS Fargate + EC2 GPU CP** | **EC2 + k3s** |
|---|---|---|---|---|
| Control plane $/mo | $73 | $73 | **$0** | **$0** |
| Node-management surcharge | $0 | ~12 % of EC2 ≈ **$30** | (premium is inside the Fargate vCPU rate) | $0 |
| Non-GPU compute $/mo (on-demand) | 3× m7g.xlarge = **$255** | **$285** | 6 vCPU + 12 GiB, 24/7 ≈ **$216** | **$255** |
| ...with 1-yr Compute Savings Plan | ~$169 | ~$199 | n/a (Fargate SP exists, lower discount) | ~$169 |
| GPU $/mo (14 h/day) | g5.xlarge = **$515** | **$515** | **$515** (ECS/EC2 capacity provider) | **$515** |
| **Compute total (on-demand)** | **$843** | **$873** | **$731** | **$770** |
| Existing Kustomize/Argo reuse | ✅ ~90 % | ✅ ~90 % | ❌ **full rewrite to task definitions** | ✅ 100 % |
| GPU support | ✅ | ✅ | ⚠️ EC2 capacity provider only — **Fargate cannot run GPUs** | ✅ |
| DaemonSets (node-exporter, Alloy) | ✅ | ✅ | ❌ **no DaemonSet concept** — observability stack breaks | ✅ |
| Scale-to-zero GPU | ✅ Karpenter, first-class | ✅ | ✅ capacity provider | ⚠️ manual ASG schedule |
| Spot + consolidation | ✅ best-in-class | ✅ | ✅ | ⚠️ DIY |
| Multi-AZ zero-downtime | ✅ | ✅ | ✅ | ❌ you build it |
| Node patching / upgrades | you own it | **AWS owns it** | AWS owns it (Fargate) | **you own everything** |
| Ops burden | Medium | **Low** | Low–Medium | **High** |
| Migration effort | **Low** | **Low** | **High** | Lowest |

### 3.3 Why Fargate loses despite the cheapest number

It shows $731 — the lowest compute total — and it is still the wrong answer:

- **Cannot run GPUs.** The GPU tier has to sit on ECS/EC2 anyway, so you operate two paradigms, not one.
- **No DaemonSets.** node-exporter, Alloy log collection, and the NVIDIA device plugin all assume per-node placement. Your entire observability stack would need rebuilding around sidecars or a managed service.
- **No hostPath, no `runtimeClassName`.** Both are load-bearing in the current manifests.
- **Image pull is not cached across tasks.** Your Python images are large and the STT CUDA image is multi-GB. Fargate re-pulls per task — cold starts get materially worse, on a service whose startup probe already tolerates 15 minutes.
- **The Kustomize/Argo investment is written off entirely.**

### 3.4 Recommendation

**EKS + Karpenter, `ap-south-1`.**

The deciding factor is not the $112/month gap — it is that ~90 % of the existing manifest tree ports with changes measured in fields, not rewrites, and GPU + DaemonSets are hard requirements only Kubernetes satisfies. You already run Argo CD, Kustomize overlays, the NVIDIA GPU Operator, and sync waves; that skill transfers directly.

**Take EKS Auto Mode instead if fewer than two people on the team are comfortable operating Kubernetes nodes.** The ~$30/month surcharge is cheap for removing node patching, autoscaler tuning, and add-on lifecycle from your plate at this scale — and the manifests port identically either way. This is a team-shape decision, not a technical one.

**Region: `ap-south-1` (Mumbai), not `ap-south-2` (Hyderabad).** Hyderabad is missing `g4dn`, `inf2`, `p4d`/`p5`, and `g6e` entirely, and its EKS/Bedrock/Aurora-Serverless-v2 parity could not be independently verified. Mumbai also satisfies India-residency for DPDP and ABDM purposes, since it is a physical region inside India.

---

## 4. Target Architecture

### 4.1 Service mapping

| Today (self-hosted) | AWS target | Rationale |
|---|---|---|
| k3s on one `dell` node | **EKS 1.31+, 3 AZs, Karpenter** | Manifests port; GPU + DaemonSets required |
| Traefik (k3s built-in) | **AWS Load Balancer Controller → ALB** | **Must set `idle_timeout.timeout_seconds: 3600`** — default 60 s will sever every SSE stream and WebSocket |
| (no TLS anywhere) | **ACM cert on ALB + external-dns → Route 53** | Currently a total gap, including `GF_SECURITY_COOKIE_SECURE` in prod asserting a certificate that does not exist |
| Postgres VM `10.10.1.250` / Patroni HA | **RDS PostgreSQL, Multi-AZ, `db.m7g.large`, gp3** | pgvector required for `UserVoiceProfile.embedding`. ⚠️ **Verify RDS supports PG 18** — schema targets it; PG 17 fallback is likely fine but must be confirmed. |
| Redis VM `10.10.1.120` | **ElastiCache Valkey, 2-node Multi-AZ replication group, `cache.t4g.small`** | Valkey is ~20–33 % cheaper than Redis OSS. ⚠️ Persistence is disabled by design — but **BullMQ jobs live in Redis**, so a failover loses in-flight jobs. Multi-AZ replication, not a single node. |
| MinIO VM `10.10.1.102` | **S3** + gateway VPC endpoint | Loki/Tempo already speak S3 — the most AWS-ready piece of the stack. Lifecycle: audio → Standard-IA @ 30 d → Glacier IR @ 90 d. |
| Qdrant StatefulSet | **Keep self-hosted, EBS gp3** | **OpenSearch Serverless is NOT HIPAA-eligible** — that is a harder blocker than its cost. Decisive. |
| Vault (single-node Shamir, unseal keys in a cluster Secret) | **Keep Vault, switch to KMS auto-unseal + Raft + scheduled snapshot to S3** | See §4.3 — this is deliberately *not* a move to Secrets Manager |
| Temporal VM `10.10.1.10:7233` + dead in-cluster copy | **Consolidate to one in-cluster Temporal against RDS** | Delete the dead copy. ⚠️ `auto-setup` is a dev-convenience image — move to the Temporal Helm chart before prod. |
| LM Studio at `10.10.1.10:1234`, unauthenticated | **Bedrock** (see §2.3 governance flag) | Removes the selector-less-Service failure mode that took out SMR + Guardrail on 2026-08-09 |
| `hostPath: /mnt/data/models-cache` | **S3 model registry + init-container sync** | See §4.2 — the single most important portability fix |
| Self-hosted registry `10.10.1.110:5050` (plain HTTP) | **ECR** + interface VPC endpoint | Endpoint pays for itself on multi-GB CUDA image pulls during node scale-up |
| Prometheus/Grafana/Loki/Tempo in-cluster | **Keep for pilot**; AMP + AMG when ops cost exceeds ~$100/mo | Keeping it is cheaper at this scale; revisit at scale-out |
| (no StorageClass declared) | **gp3 StorageClass + EBS CSI driver** | Every PVC silently relies on k3s `local-path` today |
| (no NetworkPolicy anywhere) | **VPC CNI network policy or Cilium** | Fresh design; nothing to port |
| (no backups anywhere) | **RDS automated backups + EBS snapshot policy + Velero → S3** | Currently zero backup coverage on any PVC |

### 4.2 The model-cache fix (critical path)

Today `/mnt/data/models-cache` is a node-local `hostPath` shared by `hope-stt-v2`, `hope-stt-v2-worker`, and `hope-tts`. On EKS this breaks three ways: nodes are ephemeral under Karpenter, STT (GPU node) and TTS (CPU node) will land on **different** nodes and cannot share it, and every node replacement re-downloads weights from HuggingFace — from a PHI-adjacent pod.

**Fix: mirror all model weights into a private S3 bucket and sync via an init container.**

```
S3: s3://hope-models/{whisper-large-v3-turbo, arcaai-whisper-ml-en-gguf, kokoro-82m,
                      gliner-guard-onnx, minicheck-gguf, bge-m3, bge-reranker-v2-m3}
      │
      └─ initContainer: aws s3 sync → emptyDir (node ephemeral, Karpenter-sized)
             └─ set HF_HUB_OFFLINE=1 in the main container
```

This simultaneously: removes the hostPath, removes the HuggingFace runtime dependency, satisfies the `allow_network=False` clinical-path guardrail, makes model versions immutable and auditable, and cuts NAT egress. EFS was considered and rejected — ~$0.30/GB-mo vs ~$0.08 for EBS, and the access pattern is read-mostly-write-once, which S3 serves better.

### 4.3 Why keep Vault instead of moving to Secrets Manager

Secrets Manager is cheaper (~$10/mo for ~25 secrets) and removes a stateful component — tempting. It is still the wrong call **for now**, because Vault's role here is not only kv-v2 storage:

- The `db-secret` config tier stores **per-tenant BYOK credentials as Vault Transit ciphertext**. Replacing Transit with KMS is an application-layer rewrite of the tenant credential path, not a config change.
- `SECRETS_PROVIDER` is pluggable (`env|vault|...`), so an AWS provider is a bounded addition — but it is still new code on the critical secrets path, during a migration.

**Instead, fix the actual defect with a config change:** switch the Vault seal from Shamir to **AWS KMS auto-unseal**. That eliminates the genuinely alarming finding — five unseal keys and a root token sitting in a plaintext Kubernetes Secret inside the very cluster Vault protects — plus the manual unseal step, with no application change. Add Raft storage and a scheduled `vault operator raft snapshot save` to S3 for the missing backup story.

Adopt the 3-node HA Raft blueprint that already exists at `infrastructure/single-deployment/vault/` and was never wired into the deployment repo. Do not port the single-node stopgap forward.

Revisit Secrets Manager after the pilot, as a deliberate ticket.

### 4.4 Zero-downtime, scoped honestly

**In-window (06:00–20:00 IST):**
- 3 AZs; `topologySpreadConstraints` replacing today's soft anti-affinity (which exists only because everything ran on one box)
- `hope-api` ≥ 2 replicas, real `PodDisruptionBudget` (`minAvailable: 1`) — today **every PDB in the fleet is `minAvailable: 0`**, which is a structural placeholder providing zero protection
- RDS Multi-AZ; ElastiCache Multi-AZ replication group
- ALB target-group health checks + `preStop` drain hooks
- **Live ASR:** one GPU node + Amazon Transcribe as registered failover

**Out-of-window (20:00–06:00 IST):** declared maintenance window. GPU node group scales to zero; app tier drops to minimum replicas. Deploys, migrations, and node rotations land here.

**The cold-start trap.** STT's startup probe already tolerates 15 minutes. Add Karpenter node provisioning (~2 min) plus a multi-GB CUDA image pull (~3–5 min) and the first request after an overnight scale-to-zero could wait **10–20 minutes**. Mitigate with a **KEDA cron scaler warming the GPU tier at 05:30 IST**, 30 minutes ahead of traffic. Do not discover this in production.

---

## 5. Cost Model

> ⚠️ **Every price below is flagged for verification.** AWS renders region-specific pricing tables in client-side JavaScript, so the research pass could not extract ap-south-1 figures from AWS's own pages for most services. Instance rates come from a third-party aggregator mirroring the AWS Price List API; several managed-service rates are us-east-1 examples. **Re-run every line through the AWS Pricing Calculator with region = Asia Pacific (Mumbai) before this becomes a budget.** Treat the *shape* as sound and the *absolute numbers* as ±20 %.

### 5.1 Recommended configuration

**Always-on (24/7)**

| Item | Spec | On-demand $/mo | 1-yr Savings Plan $/mo |
|---|---|---|---|
| EKS control plane | 1 cluster | 73 | 73 |
| App-tier nodes | 3× `m7g.xlarge`, 3 AZs | 255 | ~169 |
| RDS PostgreSQL | `db.m7g.large` Multi-AZ + 100 GB gp3 | 257 | ~185 (RI) |
| ElastiCache Valkey | 2× `cache.t4g.small` Multi-AZ | ~50 | ~35 |
| S3 | ~200 GB + requests | 6 | 6 |
| EBS (PVCs: Qdrant 50, Prom 20, Loki 10, Tempo 10, Grafana 5, Vault 10) | ~105 GB gp3 | 9 | 9 |
| NAT Gateway | 1× + VPC endpoints (S3 gw, ECR, Secrets Mgr) | ~48 | 48 |
| ALB | 1 + LCU | ~22 | 22 |
| ECR | ~60 GB (CUDA images are large) | 6 | 6 |
| KMS | 3 CMKs | 3 | 3 |
| CloudWatch, Route 53, misc | | ~15 | 15 |
| **Subtotal always-on** | | **~$744** | **~$571** |

**Service-hours only (14 h × 30.4 = 426 hr/mo)**

| Item | Spec | $/mo |
|---|---|---|
| GPU node (live ASR) | 1× `g5.xlarge`, on-demand | 515 |
| GPU burst (batch STT) | `g5.xlarge` spot, queue-driven | ~60 |
| **Subtotal GPU** | | **~$575** |

**Consumption**

| Item | Basis | $/mo (pilot est.) |
|---|---|---|
| Bedrock (summarization) | pilot token volume | ~$30–80 |
| Transcribe (failover only) | incident-driven | ~$0–20 |
| Data transfer out | India egress | ~$10 |
| CI (GitHub Actions + CodeBuild) | see §6.4 | ~$60 |
| **Subtotal** | | **~$110–170** |

### 5.2 Three budget tiers

| | **Lean** | **Recommended** | **Full SLA** |
|---|---|---|---|
| App nodes | 2× m7g.xlarge, 2 AZ | 3× m7g.xlarge, 3 AZ | 3× m7g.xlarge, 3 AZ |
| RDS | `db.t4g.medium` Single-AZ | `db.m7g.large` **Multi-AZ** | `db.m7g.large` Multi-AZ + read replica |
| Redis | single `cache.t4g.micro` | 2-node Multi-AZ | 2-node Multi-AZ |
| GPU | 1× g5.xlarge **spot**, 14 h | 1× g5.xlarge **on-demand**, 14 h | 2× g5.xlarge on-demand, 14 h |
| ASR failover | none | **Transcribe** | Transcribe + hot standby |
| Observability | CloudWatch only | in-cluster stack | AMP + AMG |
| **On-demand $/mo** | **~$780** | **~$1,430** | **~$2,100** |
| **With 1-yr commitments** | **~$620** | **~$1,150** | **~$1,700** |
| Zero-downtime? | ❌ | ✅ **in-window** | ✅ in-window, faster RTO |

**The Recommended tier is the one that satisfies your stated zero-downtime constraint at the lowest cost: ~$1,150/month with 1-year commitments, ~$1,430 on-demand.**

### 5.3 Where the savings actually come from

| Lever | Saving | Notes |
|---|---|---|
| **14 h vs 24 h GPU duty cycle** | **−$355/mo** | 10/24 = 41.7 % straight reduction on GPU hours. The single biggest lever. |
| **Transcribe failover instead of a hot standby GPU** | **−$515/mo** | Buys the same zero-downtime property for incident-only cost |
| **Graviton (m7g) over x86 (m7i)** | **−~45 %** on app-tier compute | Requires arm64 rebuilds — see risk R-3 |
| 1-yr Compute Savings Plan on the always-on tier only | −~30–35 % | **Do NOT commit against the GPU fleet** — a Savings Plan on a 58 %-duty-cycle resource guarantees paying for the idle 42 % |
| Spot for the batch STT worker | −~65 % on that node | Batch tolerates interruption; live ASR does not |
| **CI change-filtering** | **−~$370/mo** | Today all 15 images rebuild on every push. See §6.4 — biggest single CI lever. |
| VPC endpoints (S3 gw + ECR) | −NAT data charges | Multi-GB image pulls dominate egress |
| S3 lifecycle on audio | grows over time | Standard → IA @30 d → Glacier IR @90 d |

---

## 6. GitLab CI → GitHub Actions Migration

### 6.1 🚨 Do not port the `dev-2.1` shim

On the current branch, `.gitlab-ci.yml:65-68` sets `SKIP_TESTS: "true"` and `rules.yml:23-26` forces `when: never` on **all 8 validate jobs and 14 of 16 scan jobs**. Builds still run, with `needs:` marked `optional: true`.

**The pipeline that runs on `dev-2.1` today ships container images built from completely unverified code** — no lint, no typecheck, no tests, no generator drift gates, no Trivy scan. This is documented as a deliberate temporary shim. It must not survive the migration. Removing it is a prerequisite, not a follow-up.

### 6.2 Feature translation

| GitLab feature | GitHub Actions equivalent | Effort |
|---|---|---|
| `workflow:` rules computing `PIPELINE_TYPE` (9 types) | A first `classify` job emitting `outputs.pipeline_type`, consumed by every downstream `if:` | **High** — load-bearing abstraction with no direct equivalent |
| `extends` + `!reference` across split files (~100+ refs, `rules.yml` alone is 395 lines) | Reusable workflows (`workflow_call`) + composite actions. **No equivalent for shared `rules:` fragments.** | **High** — largest engineering risk; this is where silent behavior drift enters |
| `needs: {optional: true}` (~40+ uses) | `if: ${{ !cancelled() && contains(fromJSON('["success","skipped"]'), needs.X.result) }}` | **High** — must be hand-translated every time; miss one and a job either fails on a legitimately-skipped dep or runs when it shouldn't |
| `rules:changes` + `compare_to` | `dorny/paths-filter` inside `classify`, feeding downstream `if:` | Medium |
| GitLab Registry (plain HTTP, LAN) | **ECR** + `aws-actions/amazon-ecr-login`; BuildKit cache → `type=registry` on ECR | Medium |
| GitLab OIDC → Vault JWT | **GitHub OIDC → IAM role** (`aws-actions/configure-aws-credentials`) for AWS; keep Vault for app secrets with rewritten `bound_claims` (`repository`, `ref`, `environment`, `job_workflow_ref`) | Medium |
| `artifacts:reports:dotenv` (`build.env` digest passing) | Parse and write to `$GITHUB_OUTPUT` | Low |
| `artifacts:reports:sast` / gitleaks SARIF | **`github/codeql-action/upload-sarif`** → native Security tab | Low — **strictly better on GitHub** |
| `interruptible` + `auto_cancel` | `concurrency: {group, cancel-in-progress}` | Low |
| `environment:` + `when: manual` on `promote-prod` | GitHub Environments + required reviewers | Low |
| `services:` | Not used today — but **needed** (see R-1) | — |
| `github-backup` mirror job | **Delete.** GitHub becomes primary. | Trivial |

### 6.3 Two things get *better* on GitHub

1. **cosign signing becomes possible.** All 14 `sign-*` jobs are currently 100 % inert — public Sigstore Fulcio does not trust the self-hosted GitLab's OIDC issuer. **GitHub Actions' issuer is on Fulcio's public allow-list.** The work is already written; the migration unblocks it. Combined with the Kyverno `verifyImages` policy (also written, also excluded pending the same Fulcio gap), this closes a supply-chain gap you have already paid to build.
2. **SARIF → native Security tab**, replacing artifacts nobody opens.

### 6.4 CI cost — and the one lever that dominates

**Runner choice: GitHub Actions with AWS CodeBuild-hosted runners.** Native integration, no runner ops, arm64 support, large disk (GitHub-hosted runners have ~14 GB free — the multi-GB CUDA image build will not fit), per-minute billing with no idle cost, and IAM-native ECR access. Alternative if cost pressure demands: `actions-runner-controller` on the same EKS cluster with a spot node pool.

```
Today:   15 images rebuilt on EVERY push (build jobs have NO `changes:` filter)
         15 × ~8 min = 120 build-min/push
         × ~20 pushes/day × $0.006/min  ≈  $430/month

With change-filtering (typically 1–3 images touched per push):
         ~24 build-min/push  ≈  $60/month
```

**Change-filtering the build matrix saves ~$370/month — more than the entire app-tier compute bill.** It is also a behavior change from today, not a like-for-like port, so it needs an explicit decision.

Second lever: **Turbo remote cache is not configured at all** — no `remoteCache`, no `TURBO_TOKEN`, `.turbo/` is in no cache path. Every `turbo build`/`lint`/`typecheck`/`test` runs stone cold on every pipeline. An S3-backed remote cache is a large, entirely unclaimed win on the validate and test stages.

### 6.5 Secrets to recreate

**GitHub Secrets / AWS Secrets Manager:** `CI_DATABASE_URL`, `CI_REDIS_URL`, `CI_REDIS_PASS`, `CI_JWT_SECRET`, `CI_API_KEY_PEPPER`, `NPM_PUBLISH_TOKEN`, `DEPLOY_TOKEN`, `PGB_SMOKE_*` (6), `NEXT_PUBLIC_API_HOST`. Vault KV paths `ci/*` and `deploy/*` map across with rewritten claims.

**Everything `CI_*` remaps:** `CI_COMMIT_SHA`→`GITHUB_SHA`, `CI_PIPELINE_URL`→ computed from `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID`, etc. — pervasive, because TASK-648 bakes these into `/app/build-info.json` in **all 12 buildable Dockerfiles**.

> ### 🚩 Rotate before migrating, not after
> Known-leaked and (per the audit) **still unrotated**: a GitLab OAuth client secret and API token for `git.taphuynh.dev` (committed via `.mcp.json`/`.cursor/mcp.json`/`.env.dev`), and two credentials in `hope-v2-deployment` history (a `gl4bits-` token and a `gldt-` deploy token, commit `08d1651`). A **live GitLab access token is committed in plaintext right now** at `deployment/argocd/bootstrap.dev.yaml:76-91`.
>
> None of these should be re-seeded into GitHub Secrets in their current form. CI scans working-tree only (`--no-git`), so history-resident leaks are invisible to the gate. The migration is the forcing function — rotate as part of it.

### 6.6 Gaps to close during migration

No SAST (add **CodeQL** — free on GitHub), no dependency scanning (add **Dependabot**), no license scanning. `scan-source` is advisory-only (`--exit-code 0`) and effectively decorative. Trivy image scanning is enforced but narrow — CRITICAL-with-a-known-fix only.

---

## 7. Implementation Plan

| Phase | Scope | Gate |
|---|---|---|
| **P0 — Decisions** | Confirm ticket number, budget ceiling, Bedrock residency posture (§2.3), EKS vs Auto Mode | Written sign-off |
| **P1 — Benchmark** | Measure real concurrent-stream capacity of whisper-large-v3-turbo + the ml-en fine-tune on one A10G (`g5.xlarge`). **All GPU sizing is provisional until this exists.** Also verify every price in §5 against the AWS Pricing Calculator. | Measured concurrency + verified cost model |
| **P2 — Landing zone (IaC)** | Terraform: VPC 3 AZ, EKS + Karpenter, ECR, RDS Multi-AZ, ElastiCache, S3 + lifecycle, KMS, IAM/IRSA, VPC endpoints, Route 53 + ACM. **Currently zero IaC exists** — all bootstrap is manual runbook commands. | `terraform apply` reproducible from scratch |
| **P3 — Debt paydown** | S3 model registry + init-container sync (kills hostPath); Vault → KMS auto-unseal + Raft + S3 snapshots; gp3 StorageClass; real PDBs; probes on `stt-v2-worker`; delete the dead Temporal; ALB `idle_timeout: 3600`; ingress + TLS | Manifests render clean; no k3s-isms |
| **P4 — arm64 rebuilds** | Multi-arch images for all Node + CPU-Python services. STT stays x86 (CUDA). | `docker buildx --platform linux/arm64` green; all tests pass on arm64 |
| **P5 — CI migration** | GitHub Actions: `classify` job, reusable workflows, `paths-filter`, ECR + OIDC, service-container test DBs, Turbo remote cache, activate cosign, add CodeQL + Dependabot, **remove the `dev-2.1` shim** | Full pipeline green on a real PR, all gates enforced |
| **P6 — Data migration** | Postgres → RDS (`pg_dump`/DMS), MinIO → S3, Qdrant re-index, Vault re-seed. **Rehearse on a restored copy first** — precedent: the TASK-644 baseline was shadow-rehearsed before execution. | Rehearsal passes; rollback documented |
| **P7 — Cutover** | Argo CD on EKS, KEDA cron scaling (05:30 warm-up), smoke tests, DNS switch, 2-week parallel run | SLA observed one full week |

---

## 8. Open Questions

1. **Budget ceiling — what is the number?** You flagged it as a hard constraint but did not supply it. §5.2 gives three tiers ($620 / $1,150 / $1,700 committed). Which ceiling applies determines whether Multi-AZ RDS and on-demand GPU survive.
2. **Bedrock residency (§2.3).** Claude in India routes via cross-region inference. Acceptable, or must clinical text stay in ap-south-1?
3. **Is the 20:00–06:00 maintenance window acceptable?** The whole cost model depends on it. 24/7 zero-downtime adds ~$500/month.
4. **EKS + Karpenter or EKS Auto Mode?** Team-shape question (§3.4).
5. **Ticket number** — confirm TASK-690.
6. **Per-customer stamps?** You selected shared-pilot, but `hope-v2-deployment` is described as a self-hosting template. If per-hospital isolated stacks are coming, the per-stamp floor (~$744 always-on) is the number that matters, and the design should shift toward shared control planes.

---

## 9. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | **CI tests target LAN-only Postgres `10.10.1.250` / Redis `10.10.1.120`** — unreachable from any cloud runner | **Critical** | Service containers per job (postgres:18 + redis:8). The TASK-689 isolated-test-Vault work suggests this is already in motion. |
| R-2 | **`PIPELINE_TYPE` + `extends`/`!reference` rewrite introduces silent behavior drift** across ~90 jobs | **Critical** | Port branch-by-branch; diff the effective job set per trigger against GitLab before cutover |
| R-3 | **arm64 rebuild breaks a native dependency** (llama-cpp-python, onnxruntime, GLiNER, torch CPU) | High | P4 gate. All have arm64 support, but each needs proving. Fallback: keep specific services on `m7i` (x86) at ~45 % higher cost. |
| R-4 | **GPU concurrency assumption wrong** — the 50-concurrent target may need 2+ A10Gs | High | P1 benchmark before committing. STT's own `ExecutionProfile` tiers (100/40/20) suggest wide variance. |
| R-5 | **Cold start after overnight scale-to-zero** — node + multi-GB CUDA pull + 15-min startup probe = 10–20 min | High | KEDA cron warm-up at 05:30 IST; pre-pull via a warm image cache |
| R-6 | **`hope-api` WS resume state is a per-process in-memory Map** — no cross-pod resume, so scaling `hope-api` past 1 replica silently degrades reconnects | High | Pre-existing defect. Either ALB sticky sessions (stopgap) or move resume state to Redis (correct fix). **Directly blocks the ≥2-replica HA requirement.** |
| R-7 | **Data-migration loss** on Postgres/MinIO/Qdrant cutover | High | Rehearse on a restored copy first (TASK-644 precedent) |
| R-8 | **Leaked credentials carried into GitHub** | High | Rotate in P0, before any secret lands in GitHub |
| R-9 | **Zero backup coverage today** on every PVC-backed component | Medium | RDS automated backups + EBS snapshot policy + Velero → S3 in P2 |
| R-10 | Prices in §5 are third-party-sourced; AWS pages render regional tables in JS | Medium | Verify every line in P1 via the Pricing Calculator, region = Mumbai |
| R-11 | RDS may not support PostgreSQL 18 yet | Medium | Verify in P1; PG 17 fallback likely fine but must be confirmed against the schema |
| R-12 | Malayalam TTS voice unconfirmed on Polly | Low | Sarvam remains the Malayalam path; do not plan a Polly migration on an unverified assumption |

---

## Change History

| Date | Change |
|---|---|
| 2026-08-13 | Initial solution design. Four parallel audits (runtime inventory, deployment-repo manifests, GitLab CI, AWS ap-south-1 pricing). Recommends EKS + Karpenter in ap-south-1, self-hosted GPU ASR with Transcribe failover, Bedrock for LLM (with residency flag), ~$1,150/mo committed at the Recommended tier. Status `Pending` — 6 open questions block P1. |
