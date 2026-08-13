<!-- Extracted from the assessment artifact; tables lightly reflowed. -->

HOPE k3s → AWS/EKS Portability Assessment

 
 
Infrastructure Assessment — 2026-08-07

 
# Can HOPE move from k3s-on-Proxmox to AWS/EKS — and should it, for the GPU workloads?

 
A portability matrix, a ranked list of manifest changes to make now, and a HIPAA/EKS baseline, built from the live `hope-v2-deployment` Kustomize tree (24 base manifests, dev/staging/prod overlays) and current AWS practice.

 
 Repo audited hope-v2-deployment @ deployment/k8s/base + overlays/{dev,staging,prod}
 Cluster single-node k3s v1.34.5+k3s1, containerd 2.1.5, Traefik+servicelb, local-path, 2× GPU passthrough
 
 

 

 
 
 Control plane & stateless services
 **[Portable]** low effort
 
 
 Stateful node-local infra
 **[Rework required]** Vault, observability, Ollama
 
 
 GPU workloads (STT, Ollama)
 **[Hybrid recommended]** see §4
 
 
 HIPAA on AWS
 **[Feasible]** BAA + config, not automatic
 
 
 Cost multiple, GPU 24/7
 **[~4–8×]** vs. the Proxmox box
 
 

 
 
## 0A source-of-truth problem, found before anything else

 
 
**Three repos tell three different stories about where GitOps lives**

 
The monorepo's own rule file (`.claude/rules/09-infrastructure-devops.md`) still describes a `deployment/k3s/base/` Kustomize tree living inside `hope-v2`. The monorepo's `deployment/README.md` says that tree was **deleted 2026-07-24** (commit `1de5b8c1`) and that the live path is a *separate* Helm-values repo, `hope-deployments`, written to by `.gitlab/ci/deploy.yml`. `hope-v2-deployment` — the repo this assessment actually audited — is a *third*, separate Git repository, with its own Kustomize base/overlays, real hostnames, and commits as recent as 2026-08-04.

 
None of the three repos contains an ArgoCD `Application`/`AppProject` manifest. So there is currently no artifact anywhere that says which repo + path + revision Argo CD is actually syncing — only prose in a stale rules file claiming `hope-v2-dev` auto-syncs `main` and `hope-v2-prod` manual-syncs a `prod` revision.

 
 
This matters for the AWS question directly: **before deciding how to migrate the deployment pipeline, confirm which repo is real.** Everything below analyzes `hope-v2-deployment` as found, since it's the one with live-looking values and the most recent commits — but if Argo CD is actually pointed at `hope-deployments`/Helm, this whole tree may be a parallel, partially-stale experiment. That's a five-minute check (`kubectl -n argocd get application -o yaml` on the real cluster) that should happen before any of the work in §2.

 
Separately: the task brief assumes a "Traefik + Cloudflare Tunnel" ingress model. No `cloudflared`, tunnel, or Cloudflare reference exists anywhere in `hope-v2-deployment` — the only ingress object in the whole repo is one Traefik `Ingress` for Grafana (`grafana.yaml:111-129`), and `hope-api`/`hope-ui` are reached only via raw `NodePort` (30088/30080). If a tunnel exists, it's configured outside this GitOps tree (host-level, likely on the Proxmox box or a router) — which means the actual public-ingress story isn't reproducible from this repo either, and needs to be captured before any ALB migration is scoped.

 

 
 
## 1Portability matrix

 
Rows are ordered by how disruptive the EKS change is, worst first. "Today" cites the exact manifest; "AWS-native" names the concrete replacement, not a category.

 
 
 | 
 | Assumption| Today (k3s / hope-v2-deployment)| On EKS| AWS-native equivalent |

 
|---|---|---|---|

 
 
 | **STT model cache** **[Breaks]**
 | `hostPath: /mnt/data/models-cache`, `DirectoryOrCreate`, mounted by both `hope-stt-v2` and `hope-stt-v2-worker`; an `init-hf-cache` initContainer `chown`s it to `1001:1001`. _(stt-v2.yaml:183-187, 36-38 · stt-v2-worker.yaml:134-138, 25-38)_
 | **[Hard fail]**
 | EKS nodes are ephemeral and multi-AZ — a bare `hostPath` silently loses cache on every node replacement and can't be relied on to co-locate the worker + server pods. Replace with an **EBS gp3 PVC** (single GPU node → RWO is fine, keeps the Hugging Face cache warm across pod restarts on the same node) or, if the worker and server must run on different nodes/AZs, an **EFS PVC** (RWX) via the EFS CSI driver so both share one cache. EFS adds ~5–10ms NFS latency per model-file open, which is a one-time cost at pod start, not per-inference — acceptable here.
 |

 
 | **PVCs, no `storageClassName`** **[Changes]**
 | 7 claims, all implicit-default, all `ReadWriteOnce`: `grafana-data` 5Gi, `loki-data` 10Gi, `tempo-data` 10Gi, `prometheus-data` 10Gi, `guardrail-hf-cache` 1Gi, `hope-vault-data` 10Gi, and the `ollama` StatefulSet's `volumeClaimTemplates` entry `data` 100Gi. _(grafana.yaml:2-12 · loki.yaml:2-12 · tempo.yaml:2-12 · prometheus.yaml:2-12 · guardrail.yaml:121-132 · vault.yaml:87-95 · ollama.yaml:74-84)_
 | **[Silently defaults]**
 | k3s's implicit default is `local-path` (node-bound, not portable). EKS's implicit default (if the `gp2` in-tree class survives) is worse for a PHI workload — unencrypted by default unless the cluster sets otherwise. Every one of these 7 claims needs an explicit `storageClassName` pointing at an EBS CSI `StorageClass` with `encrypted: true`, a customer-managed KMS key, and `type: gp3` (cheaper and faster than gp2 at these sizes). All 7 are legitimately RWO workloads — none need EFS. Ollama's 100Gi in particular should get its own class with higher `iops`/`throughput` params since model pulls are bursty-large-sequential.
 |

 
 | **NodePort + single Traefik Ingress** **[Changes]**
 | 5 NodePort Services (`hope-api` 30088, `hope-admin-console` 30081, `hope-compat-playground` 30082, `grafana` 30300, plus the undeployed `hope-ui` 30080); exactly one `Ingress` object in the whole repo (Grafana, `ingressClassName: traefik`). Overlay patches target `Ingress/hope-api` and `Ingress/hope-ui` in all three environments — both are **no-ops**, since neither Ingress exists in base. _(grafana.yaml:95-129 · api.yaml:123-137 · admin-console.yaml:80-88 · compat-playground.yaml:60-68 · overlays/*/kustomization.yaml (Ingress patches))_
 | **[No servicelb, no NodePort story]**
 | k3s's `servicelb` (ships a userspace proxy that answers NodePort traffic on the node's own IP) has no EKS analogue. Standard EKS pattern: **AWS Load Balancer Controller** provisioning an internet-facing **ALB** from `Ingress` resources (or, on the current-GA path, the **Gateway API** — AWS LBC added GA Gateway API support in 2026) fronting `hope-api`/`hope-admin-console`/`hope-compat-playground`/`grafana` behind one shared ALB via `IngressGroup`, and an internal **NLB** for anything that must stay VPC-private. TLS terminates at the ALB via an **ACM** certificate referenced by annotation (or, since Dec 2025, ACM's native Kubernetes controller integration) — simpler than running cert-manager for public certs, though cert-manager is still the right tool for internal/mTLS certs Vault issues.
 |

 
 | **Vault storage backend** **[Breaks (posture, not just storage)]**
 | `storage "file" { path = "/vault/data" }` in a ConfigMap, single-replica StatefulSet, `hope-vault-data` PVC (10Gi, no storageClass). Unseal is a bespoke `Job` (`hope-vault-init`) that calls `/v1/sys/init` with a 5-share/3-threshold Shamir split and imperatively `kubectl create secret`s the root token + keys — this Secret is **not** a static manifest, it's created at apply-time. _(vault.yaml:1-32 (config), 34-85 (StatefulSet), 87-95 (PVC), 97-159 (init Job + RBAC))_
 | **[Single point of failure, manual unseal ops]**
 | File storage backend is a documented anti-pattern for anything beyond dev — no HA, and Shamir unseal means someone has to manually feed 3 key shares back in after every pod restart (or the bespoke init Job has to re-run, which it isn't built to do idempotently against an already-initialized-but-sealed Vault). On EKS: move to **Vault's `awskms` auto-unseal seal stanza** (region + `kms_key_id`, no Vault Enterprise required) so Vault unseals itself against a KMS CMK on every restart, and move storage off local `file` to either **Integrated Storage (Raft) across 3 replicas on EBS PVCs** or point Vault at **PostgreSQL storage backend** against the same RDS instance already in the platform. Either way, delete the imperative unseal Job entirely — it's the wrong shape once auto-unseal exists.
 |

 
 | **Observability stack storage** **[Changes]**
 | Prometheus (10Gi, 7d retention, `prom/prometheus:v3.10.0`), Loki (10Gi, filesystem object store, 168h retention, `grafana/loki:3.7.1`), Tempo (10Gi, local backend, 72h block retention, `grafana/tempo:2.10.3`), Grafana (5Gi) — all single-replica Deployments with node-local PVCs, no object storage. _(prometheus.yaml · loki.yaml · tempo.yaml · grafana.yaml · observability-config.yaml:1-331)_
 | **[Works, but wastes EKS's actual value here]**
 | These will run on EBS gp3 PVCs unmodified and work fine — the storage isn't shared across pods so RWO is correct. But this is the cheapest place to get real durability wins: Loki and Tempo both support **S3-backed object storage** natively (swap the filesystem chunk/backend config for an S3 bucket + IAM role), which turns "10Gi node-local, gone if the PVC is lost" into "unbounded, versioned, cross-AZ." Prometheus can either stay on a PVC (7-day retention is short enough that EBS is fine) or move to **Amazon Managed Service for Prometheus** if you want to stop operating it at all. Do the S3 swap for Loki/Tempo; leave Prometheus on EBS unless there's appetite to drop self-hosted Prometheus entirely.
 |

 
 | **Ollama model volume** **[Changes]**
 | StatefulSet `hope-ollama`, `volumeClaimTemplates` 100Gi, headless Service, GPU via `runtimeClassName: nvidia` + `NVIDIA_VISIBLE_DEVICES` env var (see GPU row below). _(ollama.yaml:19, 47, 74-99)_
 | **[Fine on EBS, expensive to keep warm]**
 | 100Gi gp3 PVC on the GPU node works unchanged. The real EKS-specific decision is whether Ollama stays as a warm StatefulSet (pay for the GPU node 24/7) or becomes a scale-to-zero Karpenter-provisioned pool that pulls models from an S3-backed registry on cold start — see §1a.
 |

 
 | **GPU scheduling** **[Breaks (undersells the real risk)]**
 | `nvidia.com/gpu` appears *only* as an env-var string (`NVIDIA_VISIBLE_DEVICES: "nvidia.com/gpu=0"` / `=1`) on `hope-stt-v2`, `hope-stt-v2-worker`, `hope-ollama` — **none** declare an actual `resources.limits["nvidia.com/gpu"]`. GPU access is granted purely via `runtimeClassName: nvidia`, so the scheduler has zero visibility into GPU capacity or contention. This is confirmed live: `allocatable nvidia.com/gpu: 2` with no pod requesting a GPU resource. The repo's own README claims stt-v2 "requests `nvidia.com/gpu: 1`" — that request does not exist in the manifests. _(stt-v2.yaml:21,58 · stt-v2-worker.yaml:21,56 · ollama.yaml:19,47)_
 | **[Two pods can silently double-book one GPU]**
 | This isn't a k3s-vs-EKS difference — it's a latent bug that happens to be harmless today only because there's exactly one node. Fix it regardless of cloud target: add real `resources.limits: {nvidia.com/gpu: "1"}` blocks and install the **NVIDIA device plugin** (or let EKS Auto Mode manage it) so the scheduler actually enforces exclusivity. On EKS this becomes load-bearing the moment there's more than one GPU node, which is the whole point of moving — see §1a for instance families, Karpenter, and time-slicing.
 |

 
 | **Postgres (app + STT + Temporal DBs)** **[Straightforward]**
 | External VM, Patroni HA, reached via `DATABASE_URL`/`STT_V2_DATABASE_URL`/`TEMPORAL_DB_*` from the `hope-secrets` Secret — app code already speaks PgBouncer transaction-mode pooling plus a separate `DIRECT_URL` for migrations (advisory locks need an un-pooled connection). _(api.yaml:80-84 · db-migrate.yaml:27-32 · temporal.yaml:44-84 · packages/database/src/client.ts:46-66 · packages/database/prisma.config.ts:24-40)_
 | **[Direct swap]**
 | **RDS for PostgreSQL or Aurora PostgreSQL**, Multi-AZ. Keep self-managed **PgBouncer** (sidecar or its own small Deployment) rather than switching to **RDS Proxy** — published benchmarks show PgBouncer transaction-mode delivering ~2.2× the throughput of RDS Proxy for steady-state traffic, and this platform's `PRISMA_PG_MAX`-budgeted, DIRECT_URL-for-migrations pattern already assumes PgBouncer's specific connection-pinning behavior. RDS Proxy is the right call for bursty Lambda-style access patterns, which this isn't. Point `DIRECT_URL` at the RDS/Aurora writer endpoint directly (bypassing the pooler) for migrations, exactly as today's un-pooled convention requires.
 |

 
 | **Redis** **[Direct swap]**
 | External VM, no persistence (PHI posture — deliberate), reached via `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASS` secretRefs interpolated into `REDIS_URL` with K8s `$(VAR)` substitution. _(api.yaml:37-41,78-79 · guardrail.yaml:46-47 · smr.yaml:50-51 · stt-v2.yaml:78-79)_
 | **[Direct swap]**
 | **ElastiCache for Redis (or Valkey)**, Multi-AZ, encryption in transit + at rest, AUTH token via Secrets Manager. No app-code changes — same env-var contract.
 |

 
 | **MinIO / object storage** **[Already speaks the target API]**
 | External VM MinIO, reached via `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` secretRefs; bucket names in plain ConfigMap values. _(stt-v2.yaml:80-96 · stt-v2-worker.yaml:66-82 · configmap.yaml:33-34)_
 | **[Trivial]**
 | The blob-storage layer already uses `@aws-sdk/client-s3` `S3Client` against a MinIO endpoint override — confirmed in `packages/applications/src/services/baseServices/storage/s3/s3.service.ts` in the monorepo, and the schema's `TenantStorageConfig.credentialsRef` already resolves storage credentials through the same SecretsService/Vault path used for everything else (`packages/database/src/prisma/db_main/tenant-bucket.prisma:122-172`). Pointing at real **S3** means dropping the endpoint override and switching credential resolution to **IAM (Pod Identity)** instead of a static access-key/secret-key pair — net reduction in secret surface, not an added one.
 |

 
 | **Qdrant** **[Undocumented in this repo]**
 | No reference anywhere in `hope-v2-deployment` — not in `configmap.yaml`, not in any base manifest, not in `secrets.dev.yaml.example`. Live facts list it as part of the data plane, so it's reached some other way not captured in this GitOps tree.
 | **[Can't assess portability of what isn't declared]**
 | Qdrant has no AWS-managed equivalent — it stays self-hosted regardless of cloud, either as a StatefulSet with EBS-backed PVCs on EKS or continuing on its current VM. Before scoping the EKS move, find and add its connection config to this repo; right now it's an undocumented dependency.
 |

 
 | **Temporal** **[Two contradictory backends declared]**
 | The repo deploys an in-cluster `hope-temporal` Deployment + Service + UI (`temporal.yaml`), but the repo's own README says `hope-harness` is actually configured against a **separate VM-hosted Temporal at 10.10.1.10:7233** via `TEMPORAL_ADDRESS` in `hope-config`. Both can't be authoritative. _(temporal.yaml:1-132 · harness.yaml:55-59)_
 | **[Depends which one is real]**
 | If the VM-hosted instance is authoritative: no portability question, it stays external (or migrates to **self-managed Temporal on EKS backed by RDS** as its own project). If the in-cluster Deployment is meant to be real: it should become a StatefulSet-per-service or use the official Temporal Helm chart, backed by RDS via `TEMPORAL_DB_*`, same as today — but resolve which backend is live before touching this in the AWS migration; don't port a dead manifest.
 |

 
 | **Vault AppRole auth from app pods** **[Changes]**
 | `hope-api` carries `VAULT_ADDR`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID` env vars and does AppRole auth in application code against `hope-vault:8200`; local dev mints a reusable raw `secret_id` via `scripts/refresh-vault-creds.sh`. Secrets ultimately land in a materialized K8s `Secret` (`hope-secrets`) referenced by every workload's `secretKeyRef`/`envFrom`. _(api.yaml:43-56 · scripts/refresh-vault-creds.sh:72-96 (monorepo))_
 | **[Vault stays; the delivery mechanism should tighten]**
 | The monorepo's own infra rule is explicit that materialized K8s Secrets are the wrong posture for PHI (`.claude/rules/09-infrastructure-devops.md`: *"Vault injection over materialized k8s Secrets... ESO is acceptable only for non-PHI"*) — and today's manifests do exactly that everywhere. On EKS, keep Vault (the platform is committed to it) but move to **Vault Agent Injector sidecars** (the monorepo already has an unused reference contract for this at `deployment/vault-agent/reference-deployment.yaml`) so secrets land in an in-memory volume the app reads at startup, never a K8s Secret object. Vault itself authenticates cross-service via AppRole as today (unaffected by cloud), but the pod's identity used to reach Vault/AWS APIs should shift to **EKS Pod Identity** (current AWS direction, GA since re:Invent 2023, no OIDC provider setup) rather than static `VAULT_ROLE_ID`/`SECRET_ID` env vars.
 |

 
 | **Registry** **[Changes CI, not the app]**
 | Self-hosted GitLab CE 18.8.6 registry, images at `registry.taphuynh.dev/arca/hope-v2/<svc>`. _(overlays/dev/kustomization.yaml:122-156 (image rewrites))_
 | **[CI push target + pull-secret plumbing changes]**
 | **ECR**. GitLab CI keeps building the images (GitLab CE has no bearing on this — it's SCM/CI, not registry-coupled) but the push step switches to `aws ecr get-login-password` + push, and the base kustomization's `images:` block repoints to the ECR registry URI. On the cluster side, EKS nodes' instance role can pull from ECR in the same account with no imagePullSecret at all — actually simpler than the current registry-credential Secret flow (the deployment repo's `base` kustomization doesn't currently show one, worth confirming it exists somewhere for the GitLab registry pulls).
 |

 
 | **Argo CD + Rancher/Fleet** **[Mostly unaffected]**
 | Argo CD on a separate VM, syncing `overlays/dev` (per live facts); Rancher + Fleet agent both present on the same cluster. _(no Application/AppProject manifest found in any of the 3 repos — see §0)_
 | **[No change to the tool, only the target]**
 | Argo CD works identically against an EKS API server — nothing about GitOps sync changes. Two decisions worth making explicitly: (1) does Argo CD itself move into the AWS account (e.g. on a small EKS-hosted controller, or Argo CD on EKS via the official Helm chart) or keep running off-cluster on the VM and simply add a second cluster context; (2) is Rancher/Fleet still earning its keep once EKS's own console + Argo CD cover cluster visibility and multi-cluster delivery — it's redundant with Argo CD for GitOps and adds an agent + RBAC surface with no HIPAA-specific value on a single-cluster target. Worth a deliberate keep/drop call, not default carry-forward.
 |

 
 
 
 

 
 
### 1a — GPU deep dive

 
Today: 2 passthrough GPUs on one Proxmox VM, no time-slicing, no pod actually requesting a GPU resource (see matrix row above — that's a real bug to fix before any migration, cloud or not).

 
 - **Instance families for inference.** **G6** (NVIDIA L4) is the right default for STT (Whisper-class ASR) and small-to-mid LLM inference via Ollama — better inference-per-dollar than G5's older A10G, and cheaper on both on-demand and spot (G6.xlarge ≈ $0.80/hr on-demand vs G5.xlarge ≈ $1.01/hr). Reach for **G5** only if a specific model needs A10G's extra VRAM headroom over L4. **P5** (H100) is overkill for this platform's workload shape — it's built for training/large-batch inference, not a single-tenant STT+summarization pipeline; skip it unless a future capability genuinely needs H100-class throughput.
 - **Karpenter vs managed node groups.** Use **Karpenter**, not static managed node groups, specifically because today's GPU utilization is bursty (STT only runs during active consultations). Karpenter can scale the GPU node pool to zero between sessions and provision a G6 node in the ~60–90s class when a pod actually needs one — a managed node group either sits warm 24/7 (defeating the cost case for cloud) or requires manual/CA-based scaling that's slower to react. One documented gotcha: some P5/G6 instance types currently report GPU count as 0 to `ec2:DescribeInstanceTypes`, which can make Karpenter mis-schedule non-GPU pods onto expensive GPU nodes — exclude those families from general-purpose NodePools with a `NotIn` requirement until AWS patches it.
 - **NVIDIA device plugin.** Required regardless of Karpenter/MNG choice — it's what turns `nvidia.com/gpu` into a real schedulable resource (fixing the exact gap flagged in the matrix row above). **EKS Auto Mode** bundles GPU support including the device plugin automatically; classic/self-managed clusters need it installed as a DaemonSet.
 - **Time-slicing / MIG.** **MIG is not available on G5, G6, or G6e** — it's a datacenter-GPU (A100/H100/P5-class) feature. On G6, the only fractional-sharing option is the device plugin's **time-slicing** config (declare N virtual GPUs per physical GPU). Given this platform's STT/Ollama workloads are latency-sensitive within a live consultation, time-slicing's lack of memory isolation is a real risk (one tenant's burst can starve another's inference) — prefer whole-GPU scheduling per pod and let Karpenter add nodes for concurrency, rather than time-slicing a single L4 across tenants.
 - **EKS Auto Mode fit.** As of July 2026 Auto Mode's GPU management fees dropped 35–60%, closing much of the cost gap with classic mode. It's a reasonable fit for the Ollama/STT GPU pool specifically because it removes device-plugin and AMI patching toil — but "limited GPU support... for heavy ML/AI workloads with specific GPUs" is still the documented caveat, so validate G6 + the exact CUDA/driver versions `hope-stt-v2`'s container needs against Auto Mode's supported set before committing; fall back to classic managed/Karpenter node groups if there's a version mismatch.
 - **Spot.** G5 spot savings run 60–70% off on-demand. Only safe for the STT *worker* (batch/queue-backed, already built to retry — see the `stt-v2-worker` Deployment) — not for the live-consultation-path `stt-v2` server or Ollama serving traffic, where a spot reclaim mid-inference is a user-visible failure.
 
 

 
 
### 1b — Data services deep dive

 
Covered inline in the matrix above (Postgres/PgBouncer, Redis, S3, Qdrant, Temporal). One number worth surfacing on the RDS Proxy question since it directly contradicts the "just use the managed proxy" instinct: RDS Proxy costs roughly **$862/mo** for a steady-state VPC-hour footprint vs. **~$119/mo** for a self-managed PgBouncer on a small EC2 instance, and PgBouncer wins on raw throughput in transaction-pool mode by ~2.2×. RDS Proxy's one real advantage — 4.2s vs 27s failover recovery — matters more for Lambda-style bursty callers than for this platform's long-lived NestJS/FastAPI connection pools. Keep PgBouncer; run it as its own small Deployment (not per-pod sidecar) so the connection budget math in `packages/database/src/client.ts:46-48` (`pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections`) still holds with one shared pool.

 

 
 
### 1c — Vault & secrets deep dive

 
The platform is committed to Vault (per the brief) — this isn't a "replace Vault with Secrets Manager" question, it's "how does Vault fit into an AWS identity model." Three concrete moves:

 
 - **KMS auto-unseal.** Add a `seal "awskms"` stanza (region + `kms_key_id`) to the Vault Helm/StatefulSet config and delete the bespoke Shamir-split `hope-vault-init` Job (`vault.yaml:123-159`) — auto-unseal works on every Vault edition, no Enterprise license needed, and removes the manual 3-of-5 key re-entry that a pod restart currently requires.
 - **Pod → AWS identity: Pod Identity over IRSA.** AWS's own direction since re:Invent 2023 — no OIDC provider setup, no per-cluster trust policy, works across multi-cluster topologies. IRSA isn't deprecated and Fargate workloads still need it, but for this platform's EC2/Karpenter-based node pools, Pod Identity is the simpler, currently-recommended path for the Vault Kubernetes auth method (or for direct KMS/S3 access where Vault indirection isn't needed).
 - **Stop materializing K8s Secrets.** Every workload today reads from a plain `hope-secrets` Secret via `secretKeyRef`/`envFrom` — exactly the posture the monorepo's own infra rule calls out as wrong for PHI. The monorepo already has an unused Vault Agent Injector reference contract (`deployment/vault-agent/reference-deployment.yaml`); wiring that up so secrets land as an in-memory sidecar-rendered file instead of a Secret object is independent of which cloud runs the cluster — worth doing on k3s today, not deferred to an AWS migration.
 
 
AWS Secrets Manager has a role here too, but a narrow one: it's the right place for the handful of AWS-native credentials that gate access to Vault itself (e.g., the KMS auto-unseal key policy, RDS master credentials for the initial bootstrap) — not a parallel secret store for application secrets that Vault already owns.

 

 
---

 
 
## 2What to change in the manifests now — ranked

 
Ordered by effort-to-benefit, cheapest/highest-leverage first. Each is a change to `hope-v2-deployment` that costs little today and either removes a live bug or removes an AWS migration blocker later — do these regardless of whether/when the AWS move happens.

 
 
 
 1
 Fix the GPU resource requests — this is a live bug, not just portability prep
 **[Effort: hours]****[Benefit: high]**
 
 
Add real `resources.limits: {"nvidia.com/gpu": "1"}` to `hope-stt-v2`, `hope-stt-v2-worker`, and `hope-ollama`, and install the NVIDIA device plugin DaemonSet. Today this only matters because there's exactly one node; the moment a second GPU node exists (Karpenter on EKS, or even a second Proxmox GPU-passthrough VM), two pods can silently double-book the same physical GPU with zero scheduler awareness.

 
stt-v2.yaml:21,58 · stt-v2-worker.yaml:21,56 · ollama.yaml:19,47

 

 
 
 2
 Resolve the source-of-truth question from §0 before touching anything else
 **[Effort: 1 conversation]****[Benefit: prevents wasted work]**
 
 
Confirm on the live cluster which repo/path Argo CD actually syncs (`kubectl -n argocd get application -o yaml`), and reconcile the monorepo's stale `09-infrastructure-devops.md` claim about a deleted `deployment/k3s` tree, the `hope-deployments` Helm-values story, and this Kustomize repo. Also locate wherever the public ingress (Traefik/Cloudflare or otherwise) actually terminates — it's not declared anywhere in this repo.

 

 
 
 3
 Split base into environment-agnostic base + cloud components
 **[Effort: 1–2 days]****[Benefit: makes every later step additive, not a rewrite]**
 
 
This is the actual "make AWS cheap later" move. Today nothing in `base/` hardcodes k3s, which is good — but nothing in `base/` is *explicit* either (no `storageClassName`, no `ingressClassName` variable, no resource requests on GPU pods). Move every cloud-specific field out to a Kustomize **component** per target, so `base/` stays a pure description of the app and each cloud gets its own thin overlay layer. Proposed structure:

 deployment/k8s/
 # unchanged: pure app description, zero storage classes, zero ingress classes,
 # explicit (not implicit-default) resource requests including GPU
 base/
 kustomization.yaml
 api.yaml stt-v2.yaml ... # as today, minus the assumptions below

 components/
 storage-k3s/ # local-path StorageClass refs, hostPath for stt model cache
 kustomization.yaml # kind: Component
 storageclass-patch.yaml
 storage-aws/ # gp3 EBS StorageClass (encrypted, KMS CMK) + EFS SC for the STT cache
 kustomization.yaml
 storageclass-patch.yaml
 efs-pvc-stt-cache.yaml

 ingress-k3s/ # ingressClassName: traefik
 kustomization.yaml
 ingress-aws/ # ALB annotations, ACM cert ARN, IngressGroup name
 kustomization.yaml
 alb-annotations-patch.yaml

 gpu-passthrough/ # runtimeClassName: nvidia (current single-node model)
 kustomization.yaml
 gpu-karpenter/ # nodeSelector/affinity for Karpenter-provisioned G6 pool,
 kustomization.yaml # real nvidia.com/gpu limits (item 1 above), tolerations
 secrets-k8s/ # current: secretKeyRef/envFrom against hope-secrets
 kustomization.yaml
 secrets-vault-agent/ # Vault Agent Injector annotations, no materialized Secret
 kustomization.yaml

 overlays/
 dev/ kustomization.yaml # components: [storage-k3s, ingress-k3s, gpu-passthrough, secrets-k8s]
 staging/ kustomization.yaml # same as dev today (still on-prem)
 prod/ kustomization.yaml # same as dev today (still on-prem)
 aws-dev/ kustomization.yaml # components: [storage-aws, ingress-aws, gpu-karpenter, secrets-vault-agent]
 
Kustomize `components` (not just overlay patches) are the right primitive here because storage/ingress/GPU/secrets are each an independent axis that can be mixed — an `aws-dev` overlay and a future `aws-prod` overlay both reuse the same four AWS components without duplicating patch YAML.

 

 
 
 4
 Make every PVC's storage class explicit, even on k3s
 **[Effort: 30 min]****[Benefit: removes 7 silent-default landmines]**
 
 
Add `storageClassName: local-path` explicitly to all 7 claims today (via the `storage-k3s` component above). Costs nothing now, and it's what makes the `storage-aws` component a clean 1:1 swap later instead of a hunt for which manifests were relying on an implicit default.

 

 
 
 5
 Delete the dead Ingress patches for `hope-api`/`hope-ui`, or build the Ingress they assume exists
 **[Effort: 30 min]****[Benefit: removes a silent no-op]**
 
 
All three overlays JSON6902-patch an `Ingress/hope-api` that doesn't exist in base (and prod additionally patches a nonexistent `Ingress/hope-ui` for a Service that isn't even deployed). `kubectl kustomize` succeeds silently. Either the intent was to have Ingress-fronted API access and the base object was never added, or these patches are stale — resolve one way before it's load-bearing for the ALB migration in item 3.

 
overlays/dev/kustomization.yaml:113-120 · overlays/staging/kustomization.yaml:28-35 · overlays/prod/kustomization.yaml:39-55

 

 
 
 6
 Fix the LM Studio dangling-Service reference and the two inconsistent addressing schemes
 **[Effort: 1 hour]****[Benefit: removes a live bug]**
 
 
`hope-guardrail` hardcodes `http://hope-lmstudio:1234/v1` — a Service that is never created (`lmstudio.yaml` is commented out of the kustomization). Meanwhile `configmap.yaml:56` reaches the same external LM Studio instance via the raw node IP `10.10.1.10:1234`. Pick one addressing pattern (an `ExternalName` Service pointing at the VM is the cleanest — it also happens to be the pattern that ports cleanly to a VPC-peered or PrivateLink'd external endpoint on AWS) and use it everywhere.

 
guardrail.yaml:64-65 · configmap.yaml:56 · lmstudio.yaml (excluded) · kustomization.yaml:16

 

 
 
 7
 Swap Vault's file storage + Shamir-Job for KMS auto-unseal + Raft
 **[Effort: 1–2 days]****[Benefit: fixes a real single-point-of-failure, cloud-agnostic win]**
 
 
Independent of AWS — file-backed, single-replica Vault with a manual Shamir unseal is a production risk on k3s today. On k3s, use Integrated Storage (Raft) across 3 pods on `local-path`; the seal stanza can point at a cloud KMS from day one if either environment has cloud access, or stay Shamir-with-`vault operator unseal`-scripted until the AWS move lands `awskms`.

 
vault.yaml:1-159

 

 
 
 8
 Pin floating image tags — staging's `staging-latest` and prod's placeholder `0.0.0.0`
 **[Effort: 1 hour]****[Benefit: medium, but a HIPAA change-control gap]**
 
 
Staging retags 10 images to a floating `staging-latest` tag — not reproducible, and specifically the pattern the monorepo's own infra rule forbids (`09-infrastructure-devops.md`: images tagged without `latest`, semver/`staging-<sha8>`/`dev-<sha8>` + immutable `sha-<sha8>`). Fix regardless of cloud — it's a deployability/audit-trail issue, and becomes a HIPAA change-management question once this is a regulated environment on AWS.

 
overlays/staging/kustomization.yaml (images:) · overlays/prod/kustomization.yaml (images:)

 
 
 

 
---

 
 
## 3aHIPAA on AWS

 
A BAA (Business Associate Addendum) is what makes AWS a HIPAA business associate for the services it covers — it does not make any given *architecture* compliant. AWS's own framing, confirmed across current guidance: eligibility is necessary but not sufficient, and the shared-responsibility model still puts encryption configuration, access control, logging, and network isolation on the customer.

 
 
 | | Service| HIPAA-eligible| What the platform must still configure |

|---|---|---|---|

 
 | EKS| **[Yes]**| Encrypt K8s Secrets with a KMS CMK (envelope encryption on etcd); private API endpoint or restricted public CIDR; audit logging to CloudWatch enabled on all control-plane log types. |

 | RDS / Aurora PostgreSQL| **[Yes]**| Storage encryption (KMS CMK), TLS-required connections, automated backups encrypted, no public accessibility, IAM auth or Vault-issued credentials — never static passwords in a manifest. |

 | ElastiCache| **[Yes]**| Encryption at rest + in transit both explicitly enabled (off by default on some engine versions), AUTH token via Secrets Manager/Vault, VPC-only access. |

 | S3| **[Yes]**| Default encryption (SSE-KMS) on every bucket, Block Public Access at the account level, bucket policies scoped to VPC endpoints where PHI-adjacent, versioning + object lock for audit-relevant buckets. |

 | EFS| **[Yes]**| Encryption at rest (KMS) and in transit (TLS mount), access points scoped per-PVC as already planned in §1 for the STT cache. |

 | KMS| **[Yes]**| Customer-managed keys (not AWS-managed) for anything PHI-adjacent, key policies scoped to the specific roles that need them, rotation enabled. |

 | Secrets Manager| **[Yes]**| Scoped to the narrow bootstrap-credential role described in §1c — not a parallel store to Vault. |

 | CloudWatch| **[Yes]**| Log groups encrypted with KMS, retention policy matching HIPAA's audit-log retention expectations, no PHI in log payloads (an application-layer discipline, not an AWS setting). |

 | ECR| **[Yes]**| Image scanning on push, KMS encryption for repositories holding anything beyond public base images (none of these should contain PHI, but scan regardless). |

 
 
 
 
#### Technical controls a BAA expects, mapped to this platform

 
 - **Encryption at rest** — every one of the 7 PVCs in §1 needs its EBS StorageClass to set `encrypted: true` with a CMK; S3/EFS as above.
 - **Encryption in transit** — ALB→pod should be TLS end-to-end (not just client→ALB) for anything carrying transcription/PHI payloads, which argues for cert-manager-issued internal certs behind the ACM-terminated public edge, not plaintext inside the cluster.
 - **VPC isolation** — RDS/ElastiCache/Qdrant/Vault in private subnets, no public IPs, security groups scoped to the EKS node security group specifically (not 0.0.0.0/0 in-VPC).
 - **PrivateLink / VPC endpoints** — S3, ECR, Secrets Manager, KMS, CloudWatch Logs all support Gateway or Interface VPC endpoints; use them so PHI-adjacent traffic to AWS APIs never transits the public internet even when it's already TLS-encrypted.
 - **Audit logging** — CloudTrail (management + data events on the PHI-relevant S3 buckets), EKS control-plane audit logs, and the platform's own existing `AuditLog`/sys-event pipeline (already built per the monorepo's application-services rules) all need to land somewhere with the retention HIPAA expects — this is additive to, not a replacement for, the app-level audit trail already in place.
 
 
Sources: AWS HIPAA Eligible Services Reference (aws.amazon.com/compliance/hipaa-eligible-services-reference), AWS Control Tower HIPAA guardrails documentation.

 

 
 
## 3bEKS production baseline, 2026

 
 
 | | Decision| Current state (2026) |

|---|---|---|---|

 
 | **Version support policy**| 14 months standard support from GA, then up to 12 months extended support at $0.60/cluster-hour (~$4,380/yr extra). EKS 1.33 exits standard support 29 July 2026 — track the version this cluster targets against that calendar; extended support is a real line item, not a grace period to ignore. |

 | **EKS Auto Mode — appropriate here?**| **[Partially]**. Good fit for the stateless services (api/smr/guardrail/nlp/harness/admin-console) — removes AMI patching and node-group toil entirely. GPU support improved materially in 2026 (35–60% management-fee cut in July), but AWS's own docs still flag "limited GPU support... for heavy ML/AI workloads with specific GPUs" as a classic-mode reason. Recommendation: Auto Mode for the CPU pool, classic managed node groups + Karpenter for the GPU pool until Auto Mode's GPU story is validated against this platform's exact CUDA/driver requirements. |

 | **Managed node groups vs Karpenter**| Karpenter for GPU (bursty, needs fast scale-to-zero — see §1a). Managed node groups are fine for the steady-state CPU services where load is predictable and the operational simplicity of a fixed ASG-backed group outweighs Karpenter's flexibility. |

 | **Pod Identity vs IRSA**| Pod Identity is AWS's current direction for new EC2-based workloads (no OIDC setup, role portability across clusters) — use it for all new IAM-role bindings. IRSA has no deprecation timeline and stays required for any Fargate workload; don't migrate existing IRSA bindings without a concrete reason (ABAC, cross-cluster role reuse). |

 | **VPC CNI vs Cilium**| Default to the AWS VPC CNI unless there's a concrete need Cilium solves that VPC CNI doesn't (e.g., L7 network policy, Hubble observability, or IP-address exhaustion at a scale this platform isn't near). Cilium adds an operational surface with no HIPAA-specific benefit over VPC CNI + security groups for a workload this size. |

 | **Multi-environment account structure**| AWS's own guidance for regulated multi-environment workloads (via Control Tower / Landing Zone Accelerator) is **separate accounts per environment**, not namespaces in one account — dev and prod should not share a blast radius, an IAM boundary, or a CloudTrail stream. Given this platform already runs dev/staging/prod as separate namespaces on one cluster today, the AWS-native upgrade is 3 accounts (or at minimum dev+staging in one non-prod account, prod isolated) under Control Tower, each with its own EKS cluster — not one EKS cluster with 3 namespaces reproducing the current model. This is a bigger structural change than anything else in this report; scope it as its own decision, not a byproduct of "move to EKS." |

 
 
 
 
Sources: AWS EKS Auto Mode GPU pricing announcement (Jul 2026), AWS EKS Kubernetes version lifecycle docs, AWS EKS Pod Identity vs IRSA guidance, AWS Control Tower multi-account landing zone docs.

 

 
 
## 3cCost shape

 
Honest framing first: **self-hosting GPU is dramatically cheaper than cloud GPU at sustained utilization**, and this platform's GPU load (transcription during active consultations, on a fixed customer base) looks a lot more like "flat, predictable load" than "5× spiky launch traffic" — the exact profile the current research literature says favors on-prem.

 
 
 | | Line item| Today (Proxmox)| EKS order-of-magnitude |

|---|---|---|---|

 
 | GPU compute, 2× cards, 24/7| Sunk hardware cost + electricity/hosting only — no recurring cloud bill| 2× G6.xlarge on-demand ≈ $0.80/hr each ≈ **~$1,150/mo per card, ~$2,300/mo for two**, before EKS Auto Mode GPU management fees or Karpenter scale-to-zero savings |

 | EKS control plane| $0 (k3s is free)| $0.10/hr/cluster × 3 environments ≈ **~$219/mo** just for control planes |

 | RDS Multi-AZ (replacing Patroni VM)| Amortized VM cost| db.r6g.large Multi-AZ ≈ **$400–600/mo** |

 | ElastiCache (replacing Redis VM)| Amortized VM cost| cache.r6g.large ≈ **$150–250/mo** |

 | ALB + data transfer + EBS/EFS + CloudWatch/S3 logs + KMS + Secrets Manager| Amortized VM/disk cost| **$300–600/mo** combined, workload-dependent |

 | Extended-support surcharge (if a version lags)| n/a| $0.60/cluster-hr ≈ **~$438/mo per lagging cluster** |

 
 
 
 
Rough total for a 3-environment EKS footprint with 24/7 GPU capacity: on the order of **$4,000–6,000+/mo**, dominated by the GPU line — vs. whatever the Proxmox box + external VMs already cost as sunk/amortized infrastructure (almost certainly a fraction of that on a monthly-equivalent basis, since GPU hardware amortizes over years, not a metered hourly rate). Spot/Karpenter scale-to-zero on the STT worker and a scale-to-zero Ollama pool can meaningfully cut the GPU line if utilization is genuinely bursty rather than 24/7 — but the live facts show 2 GPUs allocatable with zero pods currently requesting one, which is either idle capacity (favors staying on-prem) or a sign the workload hasn't been GPU-profiled yet.

 
Where AWS's value actually shows up for this platform is **not** the GPU line — it's RDS Multi-AZ failover, ElastiCache managed failover, S3's eleven-nines durability replacing a single MinIO VM, and Control Tower's audit/guardrail posture for HIPAA — all real operational risk reduction versus the current single-Proxmox-box blast radius, independent of GPU economics.

 

 
---

 
 
## 4Verdict: hybrid, not full migration — at least for now

 
 
**Recommendation**

 
**Move the control plane to AWS; keep GPU inference on-prem.** Put Postgres (RDS/Aurora), Redis (ElastiCache), object storage (S3 — already spoken natively), Vault (KMS auto-unseal), and the CPU-bound services (api, smr, guardrail, nlp, harness, admin-console, compat-playground) on EKS behind ALB/ACM, inside a proper multi-account HIPAA landing zone. Keep `hope-stt-v2`, `hope-stt-v2-worker`, and `hope-ollama` on the existing Proxmox GPU box (or a colo upgrade of it), reached from the EKS VPC over a **Site-to-Site VPN or Direct Connect**, with the gateway (`hope-api`) as the only thing that talks to the on-prem STT/Ollama endpoints — the same "gateway-resolved injection" pattern the platform already uses for per-tenant Python-service config.

 
 
Why not full migration for GPU: the cost table in §3c is not close — 24/7 cloud GPU runs ~4–8× the amortized cost of owned hardware at this platform's apparent utilization, and the break-even research consistently puts the crossover around 70–80% sustained utilization in cloud's favor only at the *lowest* end of specialist-provider pricing, not hyperscaler on-demand rates. Nothing about HIPAA specifically requires GPU-in-cloud — PHI-eligible services extend to EKS/RDS/S3/EFS, but there's no compliance rule that transcription inference must happen inside AWS's network boundary, only that wherever it happens meets the same encryption/access-control bar. The current setup (VM-hosted Postgres/Redis/MinIO/Temporal outside k3s already) shows this team is comfortable with a split topology — extending that split to "control plane in AWS, GPU on-prem" is a smaller conceptual leap than it sounds.

 
Why still move the control plane: it's the place where AWS's managed-service value (Multi-AZ RDS/ElastiCache failover, S3 durability, Control Tower's HIPAA guardrails, IAM/KMS-native secrets posture) is real and mostly free of the GPU cost penalty, and it directly fixes today's single-Proxmox-VM blast radius for everything that isn't the GPU workload itself.

 
Revisit the GPU half of this call when either: (a) utilization data shows the 2 GPUs are genuinely saturated most of the day, making spot/scale-to-zero G6 capacity cost-competitive, or (b) the team wants to stop operating physical hardware entirely as an operational-risk decision, independent of cost. Until then, the manifest work in §2 — components split, explicit storage classes, real GPU resource requests — pays off for *both* paths: it's what makes "GPU on Karpenter" and "GPU stays on Proxmox, reached over VPN" equally easy choices to make later, instead of a rewrite either way.

 

 
 Assessment based on `hope-v2-deployment` (24 base manifests, dev/staging/prod overlays, audited via `kubectl kustomize` render of all three) and the `hope-v2` monorepo's application/config code and rule files. AWS practice current as of 2026-08-07 — see inline citations for the specific claims sourced from AWS documentation and third-party benchmarks.
