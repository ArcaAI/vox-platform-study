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

## 4. The egress NetworkPolicy — specified, deliberately NOT shipped

`vllm.yaml` ships an **ingress** policy (V-3). Egress is the control that would
make "weights come only from MinIO" *enforced* rather than aspirational, and
would structurally prevent a runtime HuggingFace pull out of a PHI namespace.
It is not shipped because it cannot be written correctly yet:

**`MINIO_ENDPOINT` in `hope-secrets` is `s3.taphuynh.dev`** — a **public,
proxied Cloudflare Tunnel hostname**, which TASK-828 §4 records as having **no
Cloudflare Access application in front of it**. So an egress rule scoped to
"MinIO only" would have to allow the Cloudflare edge ranges, which is close to
allowing the open internet, and would not be the control it appears to be.

**The right fix is a LAN-local MinIO endpoint for in-cluster consumers, not a
cleverer policy.** Once one exists, this is the policy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: hope-vllm-egress
  labels: { app: hope-vllm, app.kubernetes.io/part-of: project-hope }
spec:
  podSelector: { matchLabels: { app: hope-vllm } }
  policyTypes: [Egress]
  egress:
    # DNS FIRST. Omitting this is the classic egress-policy outage: every
    # hostname lookup fails and the symptom looks like a broken endpoint.
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    # MinIO. <<< REPLACE: the LAN CIDR/port MinIO actually listens on. >>>
    - to:
        - ipBlock: { cidr: 10.10.1.0/24 }
      ports:
        - { protocol: TCP, port: 9000 }
```

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
2. **Confirm the image bundles the Run:ai streamer extras**
   (`runai-model-streamer`, `runai-model-streamer-s3`). If not,
   `--load-format runai_streamer` fails at startup; the fallback is an
   init-container pre-pull onto the node `hostPath`, the shape `hope-stt`
   already uses for its model cache.
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
