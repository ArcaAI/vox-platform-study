# Research Report: MLflow + vLLM + MinIO for On-Prem LLM Inference (k8s)

**Date**: 2026-09-01
**Topic**: Is MLflow-as-registry + vLLM-as-server + MinIO-as-weight-store worth it for on-prem k8s inference?
**Scope**: Verdict, measured evidence, best practices, and deployment instructions for the HOPE homelab (k3s on VM 200, MinIO on VM 402)
**Evidence**: Built and measured end to end — see [TASK-836](../../implementation/TASK-836-MLflow-Registry-vLLM-Metal/README.md) and [TASK-835](../../implementation/TASK-835-S3-Mounted-Model-Store/README.md)

---

## Executive Summary

**Short answer: yes to two of the three, and a firm no to the third.**

| Question | Verdict |
|---|---|
| MinIO/S3 as the model weight store for vLLM | **YES** — with `--load-format runai_streamer`, not download-then-load |
| MLflow as the model registry / promotion plane | **YES** — but as CONTROL plane only, and it must be secured first |
| MLflow in the inference REQUEST path (pyfunc in front of vLLM) | **NO** — anti-pattern; it destroys the properties you run vLLM for |

The single most important distinction is **control plane vs data plane**:

- **Control plane (MLflow):** which model versions exist, which is `champion`, what
  evaluation produced that decision, who promoted it, what lineage it has. Low
  request volume, high governance value. MLflow is good at this.
- **Data plane (vLLM):** the actual tokens. High volume, latency-critical, needs
  continuous batching, PagedAttention and streaming. MLflow must be **nowhere near** it.

The working prototype in TASK-836 deliberately wired an MLflow `pyfunc` in FRONT of
vLLM to prove the integration. **Do not ship that shape.** It is a demo of wiring,
not a serving architecture — reasons in §3.2.

---

## 1. What was actually built and measured

A full loop, working:

- **MinIO** in k8s, artifacts under `s3://mlflow/`
- **MLflow 3.6.0** in k8s, sqlite backend, `--artifacts-destination s3://mlflow/`
- **vLLM** serving `Qwen3-0.6B-Q8_0.gguf` (767 MB), OpenAI-compatible API
- Register -> alias `champion` -> pull -> serve -> predict

Because the test host was a Mac, serving used **`vllm-metal`** (the official
`vllm-project` Apple Silicon plugin, MLX-backed). That substitution does not weaken
the storage/registry findings, which are platform-independent — but the GGUF-specific
findings in §5 are Metal-path only.

---

## 2. Measured evidence (the numbers that drive the verdict)

### 2.1 MLflow's artifact proxy is a ~110x bottleneck — THE decisive number

Same host, same network path, same target disk, same 805 MB object:

| Path | Time | Throughput |
|---|---|---|
| MLflow `--serve-artifacts` proxy | ~426 s | **~1.9 MB/s** |
| Direct S3 (boto3 -> MinIO) | **3.9 s** | **204 MB/s** |

`--serve-artifacts` streams every byte through the tracking server process. That is
fine for metrics, params and small artifacts; it is **unusable for model weights**.

> A 30 GB model would take **~4.4 hours** through the proxy and **~2.5 minutes** direct.

**This alone decides a deployment detail:** clients and serving pods must be given
DIRECT S3 credentials and must not fetch weights through MLflow.

### 2.2 Object storage is not the bottleneck — the access pattern is

From TASK-835, on a 3.35 GB GGUF:

| Access method | Sequential read | Egress amplification |
|---|---|---|
| `mountpoint-s3` CSI | 376 MB/s | 1.53x |
| s3fs sidecar | 312 MB/s | 1.07x |
| direct S3 download (this report) | 204 MB/s | 1.0x |

All three are fast enough. MinIO is not the constraint; how you get bytes out of it is.

### 2.3 `mmap` over S3-backed FUSE works

Contrary to a reasonable prior expectation, `mmap()` succeeded over both FUSE mounts
and served genuine HTTP range GETs (7–56 ms random page-ins), rather than degrading
into a whole-object download. Mounting a bucket as a model directory is viable.

---

## 3. The verdict, argued

### 3.1 Why MinIO/S3 as the weight store is worth it

- **Decouples weights from images.** Baking a 30 GB model into a container image makes
  the image unpullable, uncacheable and un-promotable. TASK-835's build hazard (a
  24-minute vendor download aborting mid-stream, unresumable in buildkit) is exactly
  the class of failure this avoids.
- **One artifact, many pods.** Replicas stream the same object instead of each carrying a copy.
- **It matches the existing posture.** HOPE already self-hosts MinIO (VM 402) precisely
  so PHI-adjacent artifacts never leave platform control.
- **Digest-addressable.** Fits the existing "promote by digest, never by moving a tag" rule.

### 3.2 Why MLflow must NOT be in the request path

Putting an MLflow `pyfunc` in front of vLLM (what the prototype did) costs you:

| You lose | Because |
|---|---|
| **Continuous batching** | vLLM's core throughput win. A pyfunc proxy serialises requests per worker; concurrent requests no longer join the same batch |
| **Streaming / SSE** | `pyfunc.predict()` is request/response. HOPE's gateway streams tokens (`apps/text` SSE) — a pyfunc breaks that contract |
| **The OpenAI API surface** | HOPE already speaks OpenAI-compatible to its providers. A pyfunc replaces it with a DataFrame interface nothing upstream uses |
| **Latency** | an extra Python hop, JSON re-encode, and a second process boundary per token-generating call |
| **Operational clarity** | two things to scale, two failure modes, for one inference |

MLflow's own serving (`mlflow models serve`) is built for scikit-learn-shaped models —
small, stateless, CPU, sub-100 ms. An LLM is none of those.

**Correct shape:** callers hit vLLM's OpenAI endpoint directly. MLflow decides *which
weights that vLLM pod was started with*, and never sees a token.

### 3.3 Where MLflow genuinely earns its place

- **Version + alias semantics** (`champion` / `challenger`) that a Deployment can be pinned to
- **Lineage**: which eval run, which dataset, which params produced this version
- **Promotion audit**: who moved `champion`, when — a real requirement for a clinical platform
- **Evaluation records** attached to the version, not to a wiki page

That is worth real money in a regulated setting. None of it requires MLflow to serve traffic.

### 3.4 When it is NOT worth it

Be honest about the cases where this stack is overhead:

- **You serve one or two fixed models that rarely change.** A pinned image tag plus the
  existing `AiModel` rows is simpler and has fewer moving parts. MLflow adds a database,
  a service, an auth problem and a backup obligation to solve a versioning problem you don't have.
- **You have no evaluation discipline.** A registry whose promotions are not driven by
  recorded evals is a changelog with extra steps.
- **You cannot secure it** (see §6). An unauthenticated MLflow on a PHI platform is a liability, not an asset.

---

## 4. Best practices

### 4.1 Storage / model loading

1. **Never fetch weights through MLflow.** Run the tracking server WITHOUT
   `--serve-artifacts`; give pods direct S3 credentials (§2.1).
2. **Prefer `--load-format runai_streamer`** for safetensors. It streams tensors
   concurrently from object storage into GPU memory instead of staging to disk first,
   collapsing download+load into one step. For MinIO you MUST set
   `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0` and `AWS_ENDPOINT_URL`.
3. **Bake the streamer into the image** (`vllm[runai]`); do not `pip install` at pod start.
4. **Otherwise use an initContainer** to pre-fetch into a shared volume — full control,
   and the serving container starts with a warm local copy.
5. **Or mount the bucket** (`mountpoint-s3` CSI) when many pods share many models.
   Note it is effectively **read-only**: sequential write and rename work, but
   append/reopen is refused, so nothing can *download into* the mount (TASK-835).
6. **Populate the bucket out-of-band.** A sync/verify Job writes a `.ready` sentinel;
   serving pods refuse to start without it. Never let the serving pod be the downloader.
7. **Store the format your engine actually consumes.** GGUF and safetensors are not
   interchangeable; a bucket serving both LM Studio and vLLM needs BOTH representations
   per model, in separate subtrees.

### 4.2 vLLM serving

8. **One model per pod**, pinned by digest/version, `--served-model-name` stable so
   callers never learn the underlying file path.
9. **Tune `--max-model-len` and `--gpu-memory-utilization` together** — KV-cache capacity
   vs OOM headroom. On 16 GB RTX 2000 Ada cards this is the binding constraint, not disk.
10. **Enable prefix caching and chunked prefill** for production traffic.
11. **Probes must reflect model readiness, not process liveness.** Model load takes
    tens of seconds to minutes; use a long `startupProbe` and keep `readinessProbe` on
    `/health` so the Service only receives traffic once weights are resident.
12. **Autoscale on queue depth, not CPU** (KEDA + Prometheus). Cold start is dominated by
    model load, so use generous stabilization windows — aggressive HPA thrashes.
13. **Monitor TTFT p99, KV-cache utilisation, request queue depth.**

### 4.3 MLflow as registry

14. **Postgres backend, not sqlite.** HOPE already runs Postgres HA (VM 500–502).
    sqlite is single-writer and will not survive concurrent CI writers.
15. **Log a real model, not a bare artifact.** MLflow 3.x refuses to register
    `runs:/<id>/<path>` unless it was produced by `log_model` (§5.4).
16. **Register weights AND the config/tokenizer directory together.** Weights alone
    are not servable (§5.3).
17. **Pin Deployments to an alias, not a version number** (`models:/<name>@champion`),
    and make promotion the act that triggers a rollout.
18. **Record the eval run that justified promotion** as a tag on the version.

### 4.4 Integration with HOPE's existing config plane — read this before adopting

HOPE **already has a runtime model-selection plane**: `AiModel`, `AiTaskDefault` and
`AiProviderConnection`, resolved **tenant -> SYSTEM** (`00-project-context.md`).
MLflow must not become a second, competing answer to "which model serves this request".

**Correct division:**

| Concern | Owner |
|---|---|
| Which weights exist; which version is `champion`; lineage, evals, promotion audit | **MLflow** |
| Which model a given tenant's request resolves to, at runtime | **HOPE DB** (`AiTaskDefault`, tenant -> SYSTEM) |
| Which credential funds the call (BYOK vs platform) | **HOPE DB** (`AiProviderConnection`) |

MLflow promotion should **update an `AiModel` row / trigger a redeploy**, not be consulted
per request. A runtime read of MLflow on the request path reintroduces exactly the
coupling `failMode: closed` provider selection was designed to avoid — and MLflow
has no tenant model, so it cannot express the tenant -> SYSTEM cascade at all.

---

## 5. Constraints found the hard way

### 5.1 vLLM (CUDA build) has NO GGUF support
vLLM 0.28.0's CUDA image registers 30 quantization methods; **`gguf` is not among them**,
there is no gguf quantization module, and the `gguf` package is not installed.
**On the GPU path, plan on safetensors.**

### 5.2 `vllm-metal` DOES support GGUF, but narrowly (Apple Silicon only)
- Only **Q8_0 / Q4_0 / Q4_1** (+ F32/F16/BF16). **K-quants (Q4_K_M, Q6_K, Q3_K_L) are rejected** —
  and K-quants are what most published GGUFs are.
- **Multimodal GGUF is refused outright** (`mmproj` checkpoints).
- Q8_0 costs ~1.5x the size of the same model's Q4_K_M (767 MB vs 462 MB).

### 5.3 A `.gguf` is not a servable artifact by itself
`A .gguf carries weights only; pass --tokenizer <dir>`. A registry version must bundle
the HF config/tokenizer directory (~23 MB) or it is unservable.

### 5.4 MLflow 3.x will not register a bare artifact path
`mlflow.register_model("runs:/<id>/model")` fails with *"Unable to find a logged_model"*.
Weights must be wrapped via `log_model` to become a registry citizen.

### 5.5 Metal cannot be containerised
Linux containers on macOS have no Metal access, so `vllm-metal` cannot run in a k8s pod.
Apple Silicon is a **developer** path, not a deployment target. On-prem serving is the
CUDA path on VM 200.

---

## 6. Security posture — BLOCKING for a PHI platform

**MLflow open-source ships with no authentication.** Measured against the deployed instance:

    GET /api/2.0/mlflow/experiments/search   -> HTTP 200   (no credentials)
    OPTIONS .../registered-models/delete     -> HTTP 204   (endpoint reachable)

Anyone who can reach the port can read every experiment and **delete registered models**.
`mlflow.server.auth` exists but requires `pip install mlflow[auth]` and provides only
experimental **basic auth** (username/password), with no OIDC and no per-tenant model.

**Therefore, before any non-toy deployment:**

1. **Never expose MLflow on a routable address.** ClusterIP only; no LoadBalancer, no Ingress
   without an auth proxy in front.
2. **Put an authenticating reverse proxy in front** (oauth2-proxy / the existing gateway),
   enforcing the platform's own identity — do not rely on MLflow basic auth as the boundary.
3. **Separate MinIO credentials per role.** The MLflow server, CI writers and serving pods
   get DISTINCT MinIO service accounts with least-privilege bucket policies. Serving pods
   need **read-only** on the model prefix. **Never use MinIO root credentials** (the
   prototype did, deliberately, and that is precisely what must not ship).
4. **Store those credentials in Vault**, per `09-infrastructure-devops.md` — MinIO keys are
   `vault-kv` tier, never a plaintext DB column or a committed manifest.
5. **Treat the registry as an audited surface.** Promotion changes what a clinician-facing
   system generates; it belongs in the audit trail like any other privileged mutation.

---

## 7. Deployment instructions (HOPE homelab)

Target topology — existing infrastructure, no new VMs:

| Role | Where |
|---|---|
| k8s + GPU | **VM 200** (`10.10.1.10`), k3s, 2x RTX 2000 Ada (16 GB each) |
| Object storage | **VM 402** (`10.10.1.102`), MinIO |
| Registry DB | **VM 500–502**, Postgres HA (via PgBouncer) |

### Step 1 — MinIO: buckets and least-privilege identities (on VM 402)

```bash
mc alias set local http://10.10.1.102:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing local/mlflow          # MLflow artifacts (weights)

# Read-only policy for serving pods
cat > /tmp/models-ro.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:GetObject","s3:ListBucket"],
    "Resource": ["arn:aws:s3:::mlflow","arn:aws:s3:::mlflow/*"] } ] }
JSON
mc admin policy create local models-ro /tmp/models-ro.json

# Read-write policy for MLflow + CI writers
cat > /tmp/models-rw.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:*"],
    "Resource": ["arn:aws:s3:::mlflow","arn:aws:s3:::mlflow/*"] } ] }
JSON
mc admin policy create local models-rw /tmp/models-rw.json

mc admin user add local vllm-reader   "$(openssl rand -base64 24)"
mc admin user add local mlflow-writer "$(openssl rand -base64 24)"
mc admin policy attach local models-ro --user vllm-reader
mc admin policy attach local models-rw --user mlflow-writer
```

Put both secret keys in Vault (`vault-kv` tier); do not commit them.

### Step 2 — MLflow tracking server (k3s, ClusterIP only, NO artifact proxy)

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: mlops }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: mlflow, namespace: mlops }
spec:
  replicas: 1
  selector: { matchLabels: { app: mlflow } }
  template:
    metadata: { labels: { app: mlflow } }
    spec:
      containers:
        - name: mlflow
          image: <registry>/hope-mlflow:3.6.0     # mlflow + boto3 + psycopg2, pinned
          args:
            - mlflow
            - server
            - --host=0.0.0.0
            - --port=5000
            - --backend-store-uri=$(MLFLOW_BACKEND_URI)
            - --artifacts-destination=s3://mlflow/
            # NOTE: --serve-artifacts is DELIBERATELY ABSENT. See section 2.1 (~110x).
          env:
            - { name: MLFLOW_S3_ENDPOINT_URL, value: "http://10.10.1.102:9000" }
            - { name: AWS_DEFAULT_REGION,     value: "us-east-1" }
            - name: MLFLOW_BACKEND_URI
              valueFrom: { secretKeyRef: { name: mlflow-db, key: uri } }
            - name: AWS_ACCESS_KEY_ID
              valueFrom: { secretKeyRef: { name: minio-mlflow-writer, key: access_key_id } }
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: minio-mlflow-writer, key: secret_access_key } }
          ports: [{ containerPort: 5000 }]
          readinessProbe:
            httpGet: { path: /health, port: 5000 }
            initialDelaySeconds: 10
---
apiVersion: v1
kind: Service
metadata: { name: mlflow, namespace: mlops }
spec:
  type: ClusterIP          # NOT LoadBalancer — see section 6
  selector: { app: mlflow }
  ports: [{ port: 5000, targetPort: 5000 }]
```

`MLFLOW_BACKEND_URI` points at Postgres via PgBouncer, e.g.
`postgresql://mlflow:<pw>@10.10.1.<pgbouncer>:6432/mlflow`.

Front it with oauth2-proxy (or the HOPE gateway) before anyone outside the cluster uses it.

### Step 3 — Register a model (CI or an ops workstation)

Clients need DIRECT MinIO access, because the server no longer proxies artifacts:

```bash
export MLFLOW_TRACKING_URI=http://mlflow.mlops.svc.cluster.local:5000
export MLFLOW_S3_ENDPOINT_URL=http://10.10.1.102:9000
export AWS_ACCESS_KEY_ID=...        # mlflow-writer
export AWS_SECRET_ACCESS_KEY=...
```

```python
import mlflow
from mlflow.tracking import MlflowClient

mlflow.set_tracking_uri("http://mlflow.mlops.svc.cluster.local:5000")
mlflow.set_experiment("llm-serving")
NAME = "qwen3-8b-instruct"

with mlflow.start_run(run_name="qwen3-8b-awq") as run:
    mlflow.log_params({"quantization": "awq", "engine": "vllm",
                       "max_model_len": 8192, "dtype": "float16"})
    # Weights AND config/tokenizer together — weights alone are not servable (5.3)
    mlflow.log_artifacts("/models/qwen3-8b-awq", artifact_path="model")

c = MlflowClient()
mv = c.create_model_version(
    name=NAME,
    source=f"{mlflow.get_artifact_uri()}/model",
    run_id=run.info.run_id,
)
c.set_model_version_tag(NAME, mv.version, "eval_run_id", run.info.run_id)
c.set_registered_model_alias(NAME, "champion", mv.version)   # promotion = the rollout trigger
```

### Step 4 — vLLM serving Deployment (GPU node, streams from MinIO)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: vllm-qwen3-8b, namespace: mlops }
spec:
  replicas: 1
  selector: { matchLabels: { app: vllm-qwen3-8b } }
  template:
    metadata: { labels: { app: vllm-qwen3-8b } }
    spec:
      containers:
        - name: vllm
          image: <registry>/vllm-openai:v0.28.0-runai   # streamer BAKED IN (4.1.3)
          args:
            - --model=s3://mlflow/<experiment>/<run>/artifacts/model
            - --load-format=runai_streamer               # stream S3 -> GPU (4.1.2)
            - --served-model-name=qwen3-8b-instruct      # stable name for callers
            - --max-model-len=8192
            - --gpu-memory-utilization=0.90
            - --enable-prefix-caching
            - --port=8000
          env:
            # MinIO is path-style, not virtual-hosted — REQUIRED or the streamer fails
            - { name: RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING, value: "0" }
            - { name: AWS_EC2_METADATA_DISABLED, value: "true" }
            - { name: AWS_ENDPOINT_URL, value: "http://10.10.1.102:9000" }
            - { name: AWS_DEFAULT_REGION, value: "us-east-1" }
            - name: AWS_ACCESS_KEY_ID
              valueFrom: { secretKeyRef: { name: minio-vllm-reader, key: access_key_id } }
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom: { secretKeyRef: { name: minio-vllm-reader, key: secret_access_key } }
          ports: [{ containerPort: 8000 }]
          resources:
            limits: { nvidia.com/gpu: 1 }
          # Model load is minutes. Startup probe gates; readiness keeps traffic away. (4.2.11)
          startupProbe:
            httpGet: { path: /health, port: 8000 }
            periodSeconds: 10
            failureThreshold: 60          # up to 10 minutes to load
          readinessProbe:
            httpGet: { path: /health, port: 8000 }
            periodSeconds: 10
          lifecycle:
            preStop: { exec: { command: ["sleep", "15"] } }   # drain before SIGTERM
      terminationGracePeriodSeconds: 60
---
apiVersion: v1
kind: Service
metadata: { name: vllm-qwen3-8b, namespace: mlops }
spec:
  selector: { app: vllm-qwen3-8b }
  ports: [{ port: 8000, targetPort: 8000 }]
```

### Step 5 — Wire it to HOPE, correctly

Callers reach **vLLM directly**, never MLflow:

```
apps/text  ->  http://vllm-qwen3-8b.mlops.svc.cluster.local:8000/v1/chat/completions
```

Register the endpoint as an `AiProviderConnection` / `AiModel` row and let
`AiTaskDefault` resolve it **tenant -> SYSTEM**, exactly like any other provider
(`04-application-services.md`, `06-python-services.md`). MLflow does not appear in
this path — it decided *which weights the pod was started with*, nothing more (§4.4).

### Step 6 — Promotion flow

1. Candidate registered as a new version; eval run recorded and tagged.
2. `champion` alias moved after the eval passes.
3. CI resolves `models:/<name>@champion` to a concrete artifact URI and updates the
   Deployment's `--model` argument (GitOps commit — same digest-pinning discipline as
   `09-infrastructure-devops.md`).
4. Rollout; probes gate traffic until weights are resident.
5. Roll back by moving the alias and re-syncing — no rebuild.

---

## 8. Limitations of this study

Stated plainly, so nobody over-reads it:

- Serving was measured with **`vllm-metal` on Apple Silicon**, not CUDA on VM 200.
  Storage and registry findings are platform-independent; the **GGUF findings (§5.2) are
  Metal-only**, and §5.1 is the CUDA counterpart.
- **`runai_streamer` was NOT benchmarked here.** It is recommended on documented behaviour
  plus the §2.1 measurement showing the proxy must be bypassed. Benchmark it on VM 200
  before committing to it.
- The MLflow instance measured used **sqlite and MinIO root credentials** — deliberately,
  as a prototype. §7 specifies Postgres and scoped identities instead.
- No multi-replica, autoscaling, or concurrent-load testing was performed.
- Model sizes tested were <1 GB. **Behaviour at 30 GB+ is extrapolated, not measured.**

---

## 9. Sources

- [vLLM — Run:ai Model Streamer](https://docs.vllm.ai/en/stable/models/extensions/runai_model_streamer/)
- [vLLM — Production stack](https://docs.vllm.ai/en/latest/deployment/integrations/production-stack/)
- [vllm-metal documentation](https://docs.vllm.ai/projects/vllm-metal/en/latest/)
- [MLflow Model Registry](https://mlflow.org/docs/latest/ml/model-registry/)
- [Production-Grade LLM Inference at Scale with KServe, llm-d, and vLLM](https://llm-d.ai/blog/production-grade-llm-inference-at-scale-kserve-llm-d-vllm)
- [vLLM Kubernetes: Model Loading & Caching Strategies (DigitalOcean)](https://www.digitalocean.com/community/conceptual-articles/vllm-kubernetes-model-loading-caching-strategies)
- Internal: [TASK-835](../../implementation/TASK-835-S3-Mounted-Model-Store/README.md), [TASK-836](../../implementation/TASK-836-MLflow-Registry-vLLM-Metal/README.md)
