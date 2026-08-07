# TASK-616 Appendix A — 2026 SOTA Research Brief

**Researched**: 2026-08-06 · **Scope**: GitLab CI + Argo CD + Rancher + k3s(GPU passthrough) + OpenTelemetry
**Method**: primary sources (vendor/project docs) preferred; 2025–2026 material required; pre-2025 sources flagged inline where the underlying principle is unchanged.

This appendix records *what current best practice is*, independent of what HOPE does today. The gap analysis (what HOPE does today vs. this) lives in the ticket README §3.

---

## A1. GitLab CI → Argo CD handoff

**Recommended practice.** Pull-based GitOps. CI's responsibility ends at "push image + commit the new reference to the manifests repo"; Argo CD's begins there. GitLab explicitly discourages push-based CI-to-cluster deploys (CI runner holding live cluster credentials) for production. Both viable bridges:

| Option | Mechanism | Verdict for HOPE |
|---|---|---|
| CI commits the tag/digest | A CI job edits `overlays/staging/kustomization.yaml`, commits, pushes | **Recommended** — single writer, fully auditable, no new standing controller |
| Argo CD Image Updater | Controller polls the registry, commits on your behalf | Viable but adds a privileged always-on component holding registry creds **and** Git write access |
| GitLab Agent (KAS) push mode | CI tunnels to cluster via `agentk`↔`kas` | GitLab's own docs call the push model "weaker security model… should not use for production" |
| Flux Image Automation | Flux-native | Not applicable; the shop is Argo CD |

**Digest pinning.** Image Updater's four strategies are `semver`, `latest`, `digest`, `name`. The `digest` strategy is designed for *mutable* tags whose digest changes underneath — the opposite of HOPE's immutable `sha-<sha8>` / `staging-<sha8>` scheme. So `digest` is the wrong fit here; either `semver`/`name` matching, or (better) CI writes the digest directly.

**Gotcha.** Image Updater lives under `argoproj-labs`, not `argoproj` core — actively released through mid-2026 (v1.1.1+) but not held to core's bar. For a PHI cluster, fewer privileged always-on components is the stronger posture.

Sources: [GitLab Agent enterprise considerations](https://docs.gitlab.com/user/clusters/agent/enterprise_considerations/) · [Image Updater update strategies](https://argocd-image-updater.readthedocs.io/en/stable/basics/update-strategies/) · [digest strategy analysis](https://oneuptime.com/blog/post/2026-02-26-argocd-digest-strategy-image-updates/view)

---

## A2. Argo CD application structure

**Recommended practice.** Hybrid: an `ApplicationSet` with a **git generator** over `envs/{dev,staging,prod}/` as the factory, plus an app-of-apps root for hand-curated platform components (Vault, Temporal, cert-manager, GPU Operator). Pure app-of-apps is acceptable at one-cluster scale; ApplicationSet pays for itself the moment prod exists.

**Concrete mechanics:**

| Concern | Mechanism |
|---|---|
| Ordering | `argocd.argoproj.io/sync-wave: "-1"` (default `0`; negative runs first) — CRDs → operators → Vault → data layer → services |
| DB migrations | `argocd.argoproj.io/hook: PreSync` on the `db-migrate` Job |
| Smoke tests | `PostSync` hook |
| Failure handling | `SyncFail` hook for alert/rollback jobs |
| HPA + webhooks | `ignoreDifferences` on `spec.replicas` and any mutating-webhook-injected fields (Vault Agent Injector annotations, sidecars) — omitting this makes Argo fight the webhook forever |
| Large CRDs | `argocd.argoproj.io/sync-options: ServerSideApply=true` — avoids the 262 KB `last-applied-configuration` annotation limit once GPU Operator + Prometheus Operator CRDs land |
| Scoping | One `AppProject` per environment with `sourceRepos`/`destinations`/`clusterResourceWhitelist`. RBAC roles **must** be named `proj:<project>:<role>` or they are silently ignored |

**Progressive Syncs** (ApplicationSet RollingSync) is Beta in 2026 — low value on a single staging VM.

**Argo Rollouts: skip for staging.** Blue-green needs 2× resources concurrently (no headroom on one GPU-passthrough VM); canary needs real traffic-splitting infra (mesh or weighted NGINX) that does not exist here. Revisit when prod is multi-node.

**Auto-sync tradeoff.** `automated: {prune: true, selfHeal: true}` is the ideal, but is actively dangerous before PreSync migration hooks and `ignoreDifferences` are tuned — a self-heal loop can revert a webhook-injected sidecar mid-request.

Sources: [sync waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/) · [Progressive Syncs](https://argo-cd.readthedocs.io/en/latest/operator-manual/applicationset/Progressive-Syncs/) · [Argo RBAC/Projects](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/) · [Rollouts blue-green cost](https://www.k8s.guide/news/2026-05-13-argo-rollouts-blue-green-enterprise/)

---

## A3. Kustomize vs Helm

**Recommended practice.** Both. Helm for anything with a published upstream chart (GPU Operator, Prometheus stack, cert-manager, Kyverno); Kustomize overlays for everything authored in-house. Vendored Helm output can be post-processed through Kustomize via `helmCharts:` in `kustomization.yaml` (`kustomize build --enable-helm`).

**Config repo layout:** `base/` (one manifest per workload) + `overlays/{dev,staging,prod}/` (patches only — replicas, resources, image refs, GPU node selectors, Ingress hosts) + `components/` for optional cross-cutting patches an environment opts into (e.g. `gpu-timeslicing`). Never duplicate a full manifest per environment.

**Anti-pattern:** rewriting an upstream Helm chart as Kustomize "for consistency" — pure maintenance debt. Equally: wrapping in-house services in Helm charts that have no reuse case.

Source: [Helm/Kustomize/ArgoCD comparison](https://sanj.dev/post/helm-kustomize-argocd-kubernetes-deployment-comparison/)

---

## A4. Rancher + Argo CD coexistence

**Recommended division of responsibility:**
- **Rancher** — cluster lifecycle, inventory, RBAC/user management, cluster-level monitoring dashboards.
- **Argo CD** — all application/workload delivery.

Rancher's bundled **Fleet** is positioned by SUSE for *dozens-to-hundreds* of clusters and for cluster *configuration* delivery. At 1–2 clusters it does not earn its complexity.

**Critical rule:** never let Fleet and Argo CD manage the same namespace — both controllers will reconcile and flap. The cleanest guarantee is leaving Fleet uninstalled/disabled in Rancher (it is optional). **Document that choice explicitly in the infra README**, or someone will re-enable it from the Rancher UI because it's there.

Sources: [Fleet vs ArgoCD 2026](https://oneuptime.com/blog/post/2026-03-20-rancher-fleet-vs-argocd/view) · [SUSE App Collection: Argo CD](https://docs.apps.rancher.io/reference-guides/argo-cd)

---

## A5. k3s single-node staging hardening

Run the CIS hardening flags on staging even though it's one node — staging is where you prove the prod baseline works.

**Datastore.** Single-node k3s defaults to **embedded SQLite** (only multi-node HA uses embedded etcd). Backup = copy `/var/lib/rancher/k3s/server/db/`, or use the `k3s etcd-snapshot` subsystem (works for both). **With `secrets-encryption` on, snapshots are encrypted with a key derived from the join token — losing the token means you cannot restore. Store it in Vault.**

**Storage.** `local-path-provisioner` (k3s default) is adequate for single-node staging. Longhorn's entire value is cross-node replication, which does not exist on one VM — do not add it for "parity."

**Hardening flags (official k3s Hardening Guide, 2026 edition):**

```
protect-kernel-defaults: true
secrets-encryption: true            # aescbc default; secretbox on newer releases
kube-apiserver-arg:
  - enable-admission-plugins=NodeRestriction,EventRateLimit
  - admission-control-config-file=/var/lib/rancher/k3s/server/psa.yaml
  - audit-log-path=... --audit-policy-file=...
  - audit-log-maxage=30 --audit-log-maxbackup=10 --audit-log-maxsize=100
  - service-account-extend-token-expiration=false
kubelet-arg:
  - streaming-connection-idle-timeout=5m
  - system-reserved=cpu=500m,memory=1Gi
  - pod-max-pids=<value>
```
Plus: `chmod -R 600 /var/lib/rancher/k3s/server/tls/*.crt`, disable default-SA automount.

**k3s ships NO NetworkPolicy enforcement by default** — CIS requires every namespace to carry one; you must supply it (see A8).

**Bundled Traefik/ServiceLB is a real choice** — but see the correction immediately below before acting on it. ~~`--disable traefik --disable servicelb` if standardizing on ingress-nginx + MetalLB for prod parity.~~

> ### ⚠️ CORRECTION (2026-08-07) — do **not** migrate to ingress-nginx
>
> The Kubernetes **Steering Committee and Security Response Committee** announced on [2026-01-29](https://www.kubernetes.io/blog/2026/01/29/ingress-nginx-statement/) that **`ingress-nginx` was retired in March 2026** — *"There will be no more releases for bug fixes, security patches, or any updates of any kind after the project is retired."*
>
> That is **five months ago**. The advice above to standardize on ingress-nginx for prod parity is withdrawn: adopting it now would mean taking on an unmaintained, unpatched ingress controller on a PHI platform.
>
> **HOPE is not affected.** Verified live: the cluster runs the k3s-bundled **Traefik** (`kubectl get ingressclass` → `traefik / traefik.io/ingress-controller`, 142 d), and the repo's only Ingress uses `ingressClassName: traefik` (`base/grafana.yaml:118`). Keeping Traefik is now the correct default, not merely a defensible one.
>
> If a change is ever wanted, the recommended targets are **Gateway API** (with Envoy Gateway or a vendor controller) — which is also where the ingress-level draining knobs for long-lived WebSocket connections are better documented. Note `nginxinc/kubernetes-ingress` (F5's) and the NGINX server itself are unaffected by the retirement; only `kubernetes/ingress-nginx` is. Keeping Klipper LB on a single VM is defensible (MetalLB's L2/BGP value is moot with one node) — but **document the intentional divergence** so overlays account for it.

**What breaks on one node — write manifests that survive both shapes:**

| Construct | Single-node behavior | Portable form |
|---|---|---|
| Pod anti-affinity | `requiredDuringScheduling…` makes pods **unschedulable** | Always use `preferredDuringSchedulingIgnoredDuringExecution` |
| PDB | `minAvailable >= HPA.minReplicas` permanently blocks drains | Keep `minAvailable` strictly **less than** `HPA.minReplicas` |
| Drain/upgrade | Pods go `Pending`, never reschedule | Rehearse the k3s upgrade runbook in staging knowing it behaves differently from prod |

Sources: [K3s Hardening Guide](https://docs.k3s.io/security/hardening-guide) · [K3s backup/restore](https://docs.k3s.io/datastore/backup-restore) · [PDB/HPA deadlock](https://mdsanwarhossain.me/blog-kubernetes-pod-disruption-budgets.html)

---

## A6. GPU on k3s — several GPU-hungry pods, one passthrough GPU

**Use the NVIDIA GPU Operator**, not the bare device plugin. The Operator manages driver + toolkit + device-plugin + DCGM-exporter as one lifecycle and is the 2026 recommendation for anything beyond a single static pod.

**Sharing one GPU across ASR + LLM + TTS:**

| Mode | Requirement | Isolation | Verdict |
|---|---|---|---|
| **Time-slicing** | Any GPU | **None** (no memory isolation) | **Default choice** — ConfigMap + ClusterPolicy patch, no special hardware |
| MIG | Ampere/Hopper datacenter cards only (A100/A30/H100/H200) | Hardware memory + fault isolation, up to 7 instances | Only if the passthrough card is MIG-capable — consumer/prosumer cards are not |
| MPS | Any GPU | None, but better throughput for cooperative workloads | Least first-class Operator support in 2026; configure manually only if time-slicing latency is measurably bad |

Time-slicing config:
```yaml
apiVersion: v1
kind: ConfigMap
metadata: {name: time-slicing-config}
data:
  any: |-
    version: v1
    flags: {migStrategy: none}
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```
then
```bash
kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator --type merge -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config-all","default":"any"}}}}'
```

**k3s-specific integration point:** the Operator's `toolkit` component registers the NVIDIA runtime in `/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl`. k3s uses a *templated* containerd config precisely so operator-managed RuntimeClasses survive restarts — this differs from stock-containerd docs and must be tested explicitly. Pods then set `spec.runtimeClassName: nvidia`.

**Gotchas:**
- **The Operator does not watch the ConfigMap.** After editing time-slicing config you must `kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator` or changes silently do not apply.
- **Time-slicing has zero memory isolation.** One pod's CUDA OOM can starve or crash every co-scheduled pod. For concurrent ASR + LLM + TTS, set conservative per-pod memory assumptions and monitor DCGM — the scheduler will not protect you.
- **Proxmox passthrough:** consumer NVIDIA drivers refuse to load under a detected hypervisor (Error 43) unless hidden (`-cpu host,kvm=off,hv_vendor_id=proxmox`); IOMMU must be on in BIOS + kernel params; **VMs with passthrough devices cannot be live-migrated**, so node maintenance is a real downtime window — capacity/maintenance planning must assume this. Some GPUs do not reset cleanly on VM shutdown and hang until host reboot.

**GPU metrics:** `dcgm-exporter` DaemonSet, port 9400, Prometheus format — utilization, memory, temperature, power, SM occupancy.

Sources: [NVIDIA GPU Operator gpu-sharing](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html) · [MIG vs Time-Slicing vs MPS](https://www.kubenatives.com/p/mig-vs-time-slicing-vs-mps-which) · [dcgm-exporter](https://github.com/NVIDIA/dcgm-exporter) · [Proxmox passthrough caveats](https://homelabpicks.com/gpu-ai/gpu-passthrough-proxmox/)

---

## A7. Supply chain security

**2026 default is keyless signing** — Sigstore cosign + Fulcio short-lived certs + Rekor transparency log, no managed key material. GitLab supports it natively via OIDC ID tokens:

```yaml
id_tokens:
  SIGSTORE_ID_TOKEN: { aud: sigstore }
```
`cosign sign` picks this up automatically. **Requires cosign v2.0+.** Self-managed GitLab needs the registry metadata database enabled to *display* signatures in the UI (verification itself does not depend on the UI feature). GitLab ships a `Cosign.gitlab-ci.yml` template.

**Realistic minimum bar for a healthcare product** (≈ SLSA L1–L2 in spirit; full L3 hermetic/reproducible builds is disproportionate at this team size):

1. cosign keyless signature on every image pushed
2. Trivy CVE gate in CI that **blocks** on CRITICAL (not `allow_failure`)
3. CycloneDX SBOM attached per image as an in-toto attestation
4. Kyverno admission policy rejecting unsigned images in non-dev namespaces
5. GitLab immutable container tags on anything reaching staging/prod

**License gate:** GitLab immutable container tags are **Ultimate-tier only** (Beta in 2026, ≤5 protection rules/project, RE2 regex, Owner-role to create). If the self-hosted license is lower tier, the free substitute is **digest-pinning in Kustomize overlays — never deploy by mutable tag**. Note immutable-tagged images are skipped by cleanup policies, so scope cleanup to `dev-*`-style tags.

**SBOM format:** CycloneDX for vuln-management tooling compatibility; SPDX additionally if license compliance ever matters for a healthcare vendor audit.

Sources: [GitLab cosign tutorial](https://docs.gitlab.com/user/packages/container_registry/cosign_tutorial/) · [GitLab signing examples / id_tokens](https://docs.gitlab.com/ci/yaml/signing_examples/) · [GitLab immutable container tags](https://docs.gitlab.com/user/packages/container_registry/immutable_container_tags/) · [2026 SBOM tooling](https://devsecops.ae/sbom-tools-comparison-2026/)

---

## A8. Kubernetes security baseline for PHI

**Floor: Pod Security Admission `restricted`** — label-driven, built into k8s since 1.25, no extra controller:
```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/warn: restricted
pod-security.kubernetes.io/audit: restricted
```
(set `warn`/`audit` too so drift surfaces in logs before it is blocked).

**Layer Kyverno on top** for what PSA cannot express: mandatory labels, image-signature verification (A7), and — critically — **auto-generated default-deny NetworkPolicy per namespace** with `synchronize: true` so it self-heals if deleted. k3s enforces no NetworkPolicy by default, and "every namespace has a NetworkPolicy" is a literal CIS control.

**Secrets delivery, for a shop already running Vault HA:**

| Tool | Best for | Limitation |
|---|---|---|
| **Vault Agent Injector** | Workloads needing dynamic secrets / PKI / short-lived DB creds | Sidecar per pod |
| **Vault Secrets Operator (VSO)** | Vault-native sync into K8s Secrets, incl. dynamic secrets | Newer, Vault-only |
| **External Secrets Operator (ESO)** | Simple static KV sync from many backends | **Its Vault provider does not support dynamic secrets engines (DB/AWS/SSH) — static KV only** |

These do not conflict; the cost is operational surface area. ESO is *additive for simple secrets only* and can never replace a dynamic-creds bootstrap.

**HIPAA technical-safeguard mapping:**

| Safeguard | Cluster control |
|---|---|
| §164.312(a)(2)(iv) encryption at rest | k3s `secrets-encryption: true` for the datastore; **plus** application-layer encryption (Vault Transit ciphertext) for actual PHI — the datastore flag alone is not sufficient |
| §164.312(b) audit controls | apiserver `audit-log-path`/`audit-policy-file`, **shipped off-node** (local files are not tamper-evident) |
| §164.312(e) transmission security | TLS everywhere + default-deny NetworkPolicy |

**Caveat:** there is no "HIPAA certification" for Kubernetes. It is a mapping exercise; no vendor's "HIPAA-ready" chart substitutes for a BAA-covered infrastructure review.

Sources: [Kyverno PSA policies](https://kyverno.io/policies/psa/add-psa-labels/add-psa-labels/) · [Kyverno default-deny NetworkPolicy](https://kyverno.io/policies/other/restrict-networkpolicy-empty-podselector/restrict-networkpolicy-empty-podselector/) · [HashiCorp Vault K8s integration comparison](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/comparisons) · [ESO vs VSO](https://codingprotocols.com/blog/vault-secrets-operator-vs-external-secrets-operator)

---

## A9. Observability for multi-environment Kubernetes

**Collector topology: agent DaemonSet + gateway Deployment.** The agent handles host metrics, kubelet, and local OTLP receipt; the **gateway** does the expensive work. This split is not stylistic — **tail sampling requires seeing a whole trace (impossible per-node), and PHI redaction needs exactly one enforced choke point** rather than N per-node chances to get it wrong.

**Auto-instrumentation:** the OpenTelemetry Operator's `Instrumentation` CRD + admission webhook injects Node.js (via `--require` preload) and Python (entrypoint wrap) SDKs without hand-wiring. This is the standard 2026 onboarding path for a NestJS + 6×FastAPI fleet.

**⚠️ Promtail reached end-of-life 2026-03-02.** Do not stand up new Promtail. **Grafana Alloy** (OTel-Collector-based, unified logs/metrics/traces) is the replacement and ships `alloy convert` for migrating existing configs.

**Backend:** the full LGTM stack (Loki/Grafana/Tempo/**Mimir**) is preferred over plain Prometheus+Loki+Tempo *specifically because Mimir provides multi-tenant `X-Scope-OrgID` isolation* — the mechanism that lets one Grafana safely serve dev/staging/prod without cross-environment query leakage.

**The attributes that make one Grafana serve many environments:**

| Attribute | Note |
|---|---|
| `deployment.environment.name` | **Current stable name** — supersedes the older `deployment.environment`. Well-known values: `development`/`staging`/`production`/`test` |
| `service.namespace` | Logical grouping (e.g. `hope`) |
| `k8s.cluster.name` | Physical cluster |

Set via `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=staging,service.namespace=hope`. At the storage layer, set `X-Scope-OrgID` per environment (`hope-staging`, `hope-prod`) on the Collector's exporters so environments are storage-isolated even on shared backends.

**Metrics ingestion — not an either/or.** `ServiceMonitor`/`PodMonitor` CRDs remain the recommended default for your own `/metrics` endpoints, and the OTel Collector's `prometheus` receiver *natively consumes ServiceMonitor/PodMonitor objects*. Use the Collector's `k8s_cluster`/`kubeletstats` receivers for infra-level scraping ServiceMonitor cannot reach.

**PHI-safe processing.** The Collector's `redaction` processor is regex-based and **traces-only** — use `attributes`/`transform` processors for logs and metrics. For any service you cannot fully trust not to emit raw PHI in span attributes, the 2026 guidance is to **allowlist safe attributes rather than denylist unsafe ones**; regex redaction alone is not a sufficient control.

**Gotchas.**
- OTel semconv is still overall "Development" status even where individual attributes are Stable — pin Collector/SDK versions and re-diff on upgrade rather than tracking `latest`.
- Exemplars (metrics→traces linking) need both SDK support *and* backend exemplar storage — not enabled by default in all Mimir distros.
- **Async boundaries are where auto-instrumentation silently drops traces.** Redis Streams, SSE, WebSocket, and Temporal hops need explicit W3C `traceparent` propagation.

Sources: [OTel agent pattern](https://opentelemetry.io/docs/collector/deploy/agent/) · [OTel gateway pattern](https://opentelemetry.io/docs/collector/deploy/gateway/) · [Promtail EOL](https://community.grafana.com/t/promtail-end-of-life-eol-march-2026-how-to-migrate-to-grafana-alloy-for-existing-loki-server-deployments/159636) · [`deployment.environment.name` semconv](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/) · [Tempo multi-tenancy](https://grafana.com/docs/tempo/latest/operations/manage-advanced-systems/multitenancy/) · [Prometheus + OTel better together](https://opentelemetry.io/blog/2024/prom-and-otel/) · [Collector redaction](https://last9.io/blog/redacting-sensitive-data-in-opentelemetry-collector/) · [OTel Operator auto-instrumentation](https://oneuptime.com/blog/post/2026-02-09-otel-auto-instrumentation-operator/view)

---

## A10. Alerting and SLOs

**Alertmanager stays primary** for infra/PromQL alerts — GitOps-native, file-driven, no new always-on component. Add **Grafana unified alerting** only for genuinely cross-datasource alerts (correlating a Loki log pattern with a Prometheus metric). Running both is a split by alert *type*, not redundancy.

**SLO-as-code:** **Sloth** is the pragmatic default — its maintainer has explicitly frozen feature scope ("final form"), so the config format written today will not be deprecated underneath a small team. **Pyrra** is more actively developed and ships a web UI for burn-rate visibility, at the cost of higher churn.

**Minimal alert set for this platform:**

| Domain | Alert |
|---|---|
| Node | CPU / memory / disk saturation on the single staging VM (no failover — this is the earliest warning) |
| GPU | DCGM: temperature, ECC errors, utilization pinned at 100% for N minutes (stuck/deadlocked inference) |
| Postgres | Connection-pool exhaustion vs `PRISMA_PG_MAX`; replication lag once HA exists |
| Redis | Connection failures (note: persistence is deliberately disabled for PHI posture, so data loss on restart is *expected*, not an incident) |
| Workloads | CrashLoopBackOff across the 6 Python services + API + admin console |
| GitOps | Argo CD `OutOfSync` / `Degraded` — nothing should drift silently |
| Vault | Seal status (unsealed-but-unreachable = platform-wide outage) |
| Temporal | Worker liveness — silently stalled workflows are worse than crashed ones |
| Expiry | Certificate and Vault lease expiry warnings |

**Gotcha:** SLO tooling generates rules *from* an SLO spec — but deciding what "good" means per service (ASR p95 latency, summarization success rate) is a product decision that must precede the tooling, not follow it.

Sources: [Alertmanager vs Grafana Alerting 2026](https://dev.to/alexandrev/prometheus-alertmanager-vs-grafana-alerting-2026-architecture-features-and-when-to-use-each-48d7) · [Sloth vs Pyrra](https://medium.com/@dotdc/service-level-objectives-made-easy-with-sloth-and-pyrra-4adefe2572cf) · [Sloth](https://github.com/slok/sloth)

---

## A11. Environment parity and preview environments

**Do not pretend one staging VM equals a multi-node prod.** Make the *manifests* environment-agnostic (Kustomize overlays, `preferred` affinity per A5, sane single-node HPA `minReplicas`) so the same base definitions deploy to either shape — then **document the known divergences** explicitly:

- No real multi-node failover testing is possible in staging.
- GPU-passthrough VM live-migration limits are staging-specific if prod uses a different GPU allocation model.

**Per-MR preview environments: technically possible, poor fit here.** GitLab review apps (`environment:` + `on_stop` + `auto_stop_in`) work without the Kubernetes Agent for a hand-rolled `kustomize build overlays/preview-$CI_MERGE_REQUEST_IID | kubectl apply` flow. But full-stack previews would need GPU scheduling on the *same single passthrough GPU* already time-sliced across staging's own services, plus Postgres/Redis/MinIO/Qdrant/Vault/Temporal per MR.

**Practical middle ground:** preview environments for the **stateless, non-GPU surfaces only** — admin-console (Next.js) and the API gateway — pointed at shared staging data stores with a scoped tenant. Use `auto_stop_in: 3 days` as the orphan-namespace safety net.

**Highest-risk parity gap:** GPU allocation. Time-slicing replica counts, ClusterPolicy, and DCGM thresholds tuned against one staging GPU will not port unchanged to a different prod GPU count/model. Budget explicit re-validation.

Sources: [GitLab review apps](https://docs.gitlab.com/ci/review_apps) · [preview-env practicality for stateful/GPU workloads](https://northflank.com/blog/preview-environment-platforms)

---

## A12. Top 12 highest-leverage changes for this stack

Ranked by impact × cost-to-close. Effort: **S** ≤1 day · **M** ≈2–5 days · **L** >1 week.

| # | Change | Effort | Risk of not doing it |
|---|---|---|---|
| 1 | k3s `secrets-encryption`, PSA `restricted`, audit logging, kubelet hardening (A5, A8) | **S** | Direct HIPAA §164.312 exposure — Secrets sit unencrypted at rest in the datastore. Highest compliance-per-effort item in the brief |
| 2 | Default-deny NetworkPolicies across all namespaces (Kyverno-generated) (A8) | **S** | Any pod can currently reach Vault/Postgres/any pod — one bad Python dependency reaches PHI-adjacent stores with zero friction |
| 3 | cosign keyless signing + Kyverno admission-time verification (A7) | **M** | Without admission enforcement, the entire SBOM/Trivy investment is decorative — an unsigned or unscanned image still reaches the cluster |
| 4 | Digest-pin image references in all overlays; stop relying on tags alone for deploy correctness (A1, A7) | **S** | Tag mutability is the classic "it deployed the wrong image" incident |
| 5 | GPU Operator + DCGM + time-slicing ConfigMap for the shared passthrough GPU (A6) | **M** | Without Operator scheduling awareness, pods double-schedule onto one GPU with no memory guardrail → silent OOM-kills or corrupted inference under load |
| 6 | Automate datastore backup **and test one real restore** (A5) | **S** | Untested backups are not backups; a single-node VM has zero failover |
| 7 | Close remaining env-var-secret paths onto Vault (Agent Injector / VSO) (A8) | **M** | Vault HA already runs — any service still on env-var secrets is the one glaring inconsistency to close before prod |
| 8 | OTel Collector agent+gateway with redaction at the gateway **before** broad tracing rollout (A9) | **M** | Six services handling clinical audio; un-redacted span/log attributes are a realistic PHI-leak vector the moment tracing turns on. Sequence this *first* |
| 9 | Migrate any Promtail usage to Grafana Alloy (A9) | **S** | Promtail is past EOL — no further security fixes |
| 10 | CI-commits-the-digest handoff to Argo + PreSync hooks for Prisma/Temporal migrations (A1, A2) | **M** | Keeps Git the single source of truth; avoids adding a privileged registry-polling controller to a PHI cluster |
| 11 | `preferred` (never `required`) anti-affinity + `minAvailable < HPA.minReplicas` PDB math (A5, A11) | **S** | Otherwise every workload manifest needs a staging-specific fork the day prod launches |
| 12 | Define 2–3 real SLIs per critical path + Sloth-generated SLOs + minimal Alertmanager rules (A10) | **M** | Otherwise "is the platform healthy" is answered by vibes until a clinician complains |
