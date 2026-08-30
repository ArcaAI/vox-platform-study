# TASK-832 — changes for `hope-v2-deployment` (HANDOVER, not applied)

Authored in the app repo; **the orchestrator makes every commit to
`hope-v2-deployment`** (EXECUTION-PLAN §14.5). Nothing here has been applied
to the cluster or committed to that repo.

Goal: **no in-cluster workload addresses MinIO by a public hostname.**

---

## 0. The design decision that shapes everything below

`hope-secrets` is hand-applied and the Argo `AppProject` **blacklists Secrets**
(`appproject-dev.yaml`: `namespaceResourceBlacklist: [{group: "", kind: Secret}]`),
so Argo can never manage it and this ticket cannot change it through GitOps.

The naive plan is "ask the operator to change `hope-secrets.MINIO_ENDPOINT`".
That is the wrong shape, for three reasons:

1. **An endpoint is not a secret.** `10.10.1.102:9000` is a LAN address. Keeping
   it in a Secret puts a non-secret, review-worthy value in the one object that
   is outside Git, outside review and outside CI.
2. **It cannot fail closed.** The key already exists with the tunnel hostname in
   it. The failure mode is not absence, it is *staleness* — and a stale value
   fails *open*, straight back onto the public tunnel. That is exactly the
   failure this ticket exists to remove.
3. **It is unverifiable.** Nothing in CI can assert what a hand-applied Secret
   contains.

**So: move the endpoint out of `hope-secrets` and into the per-service
ConfigMap, referenced as a NON-OPTIONAL `configMapKeyRef`.**

- Kubernetes gives an explicit `env:` entry precedence over `envFrom:`, so the
  ConfigMap value wins over the stale `hope-secrets` key with no coordination.
  This is the same mechanism `stt.yaml` already uses to override `MINIO_ENDPOINT`
  from `envFrom`.
- A missing key becomes `CreateContainerConfigError` — the pod refuses to start
  rather than quietly reaching for the tunnel. Same fail-closed posture
  `api.yaml` already uses for `TEXT_URL`/`STT_URL`/`NLP_URL`, and TASK-823's
  CA mount.
- `config-refs` (blocking CI) now *proves* the reference resolves.
- The credential pair stays in `hope-secrets`, where it belongs.

Net effect: **the operator does not have to touch `hope-secrets` for the
endpoint at all.** They should still correct or delete the stale key (§4), but
correctness no longer depends on their doing so.

---

## 1. Config changes — endpoint + TLS

### 1.1 `deployment/k8s/base/config/api.env`

```diff
-MINIO_USE_SSL=true
+MINIO_USE_SSL=true
+# TASK-832: the LAN address of the MinIO host, replacing the public Cloudflare
+# Tunnel hostname that hope-secrets.MINIO_ENDPOINT still carries. Not a secret —
+# it is a LAN address, and it belongs in Git where it can be reviewed.
+# Referenced as a NON-OPTIONAL configMapKeyRef in api.yaml, so a missing key is
+# CreateContainerConfigError rather than a silent fallback to the tunnel.
+MINIO_ENDPOINT=10.10.1.102:9000
```

### 1.2 `deployment/k8s/base/config/stt.env`

```diff
 MINIO_AUDIO_BUCKET=hope-audio
 MINIO_CHUNK_BUCKET=hope-audio-chunks
+# TASK-832 — see api.env for the rationale.
+MINIO_ENDPOINT=10.10.1.102:9000
+# ⚠️ MINIO_SECURE was "false" while MINIO_ENDPOINT was a PUBLIC hostname, so the
+# MinIO SDK built http://s3.taphuynh.dev — plaintext PHI audio across the public
+# internet (the zone has always_use_https=off, TASK-828 §5). On the LAN address
+# this must be true: MinIO on :9000 is TLS-only, and a plaintext client to a TLS
+# port fails loudly, which is the correct direction to fail.
+MINIO_SECURE=true
+# The MinIO leaf is issued by a private CA that is in no system trust store.
+# Without this the Python SDK cannot verify and the connection is refused.
+MINIO_CERT_CHECK=true
```

### 1.3 `deployment/k8s/base/config/harness.env`

```diff
+# TASK-832 — the claim-check store IS platform object storage. Bootstrap-floor
+# values only; the admin-managed source of truth is the SYSTEM
+# TenantStorageConfig row (see the parent README §Operator procedure, step 5),
+# which the resolver applies over these.
+HARNESS_CLAIM_CHECK_ENDPOINT_URL=https://10.10.1.102:9000
+HARNESS_CLAIM_CHECK_SECURE=true
```

## 2. Deployment changes — the fail-closed reference + CA mount

Applied identically to `api.yaml`, `stt.yaml`, `stt-worker.yaml`,
`harness.yaml`, `harness-worker.yaml`. Name-based strategic merge only —
CI's `patch-hygiene` job **bans index-based JSON6902** (`/env/5/value`).

### 2.1 Repoint the endpoint (example: `stt.yaml`)

```diff
             - name: MINIO_ENDPOINT
               valueFrom:
-                secretKeyRef:
-                  key: MINIO_ENDPOINT
-                  name: hope-secrets
+                # TASK-832. NOT hope-secrets: an endpoint is not a secret, and a
+                # stale secret value fails OPEN onto the public tunnel. No
+                # `optional:` — a missing key must be CreateContainerConfigError.
+                configMapKeyRef:
+                  name: hope-stt-config
+                  key: MINIO_ENDPOINT
             - name: MINIO_SECURE
-              value: "false"
+              value: "true"
```

### 2.2 Mount the internal CA

Every direct client needs the `ARCAAI Internal CA`; the tunnel was hiding this
by presenting a public edge certificate and setting `noTLSVerify: true` toward
the origin. Going direct removes both crutches.

```diff
           volumeMounts:
+            # TASK-832 — internal CA for direct TLS to MinIO. NOT optional: the
+            # pod must fail to start rather than talk to a PHI object store it
+            # cannot verify. There is deliberately no skip-verify option.
+            - name: arcaai-internal-ca
+              mountPath: /etc/ssl/arcaai
+              readOnly: true
       volumes:
+        - name: arcaai-internal-ca
+          configMap:
+            name: arcaai-internal-ca
```

Then one env var per runtime — **the variable differs by client library and
getting it wrong looks identical to not mounting the CA at all**:

| Workload | Client | Variable |
|---|---|---|
| `hope-api` | Node (`@aws-sdk/client-s3`) | `NODE_EXTRA_CA_CERTS=/etc/ssl/arcaai/ca.crt` |
| `hope-stt`, `hope-stt-worker` | Python `minio` SDK (urllib3) | `SSL_CERT_FILE=/etc/ssl/arcaai/ca.crt` |
| `hope-harness`, `hope-harness-worker` | `boto3` | `AWS_CA_BUNDLE=/etc/ssl/arcaai/ca.crt` |

`mc`, if a Job ever uses it, reads **`SSL_CERT_FILE`** — dropping the PEM into
`<config-dir>/certs/CAs/` does **not** work (tested, TASK-823 §8.5).

## 3. NetworkPolicy

`networkpolicy-minio-egress.yaml` in this directory. **Read its §A header
before doing anything with it** — an egress policy flips the selected pods to
deny-all-egress, and `hope-v2-dev` has never run under any policy. It ships
one fully-derived policy (`hope-stt`) and templates for the rest, with the
enumeration method spelled out. Do not apply it as a batch.

There is **no** NetworkPolicy in `hope-v2-deployment` today. TASK-823 authored
the repo's first one but is **not yet handed over** — `base/kustomization.yaml`
has no `vllm.yaml` entry and the repo contains no `vllm` manifest at all. So
whichever of the two lands first establishes the convention; both follow the
same one, deliberately.

## 4. `hope-secrets` — what the operator must do (Argo cannot)

| Key | Now | Should become |
|---|---|---|
| `MINIO_ENDPOINT` | `s3.taphuynh.dev` | **Delete the key**, or set `10.10.1.102:9000`. After §2.1 nothing reads it — but leaving a public hostname in the platform Secret is a trap for the next service that wires itself up with `envFrom` and no explicit override. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | one pair with read/write over every bucket | Keep for the PHI buckets. **Add a separate `MINIO_MODELS_ACCESS_KEY` / `MINIO_MODELS_SECRET_KEY`** scoped to `hope-models` via the `hope-models-reader` policy, for weight consumers. A weight fetch should not hold a credential that can write `recordings`. |

⚠️ `hope-secrets` carries a `kubectl.kubernetes.io/last-applied-configuration`
annotation containing the **entire `stringData` block in cleartext** — every
platform secret, readable by anything that can read the Secret object even when
the viewer masks `data`. Confirmed still present 2026-08-30. Recorded in
TASK-823 §8.6 and TASK-828; **rotating without stripping that annotation does
not retire the old values.** Not this ticket's to fix, but any credential change
made here is undermined by it, so it is called out at the point of use.

## 5. Not changed here, and why

- **`arcaai-internal-ca` ConfigMap is NOT shipped as a manifest in this
  directory.** It does not exist in the cluster, and the CA PEM is not
  obtainable from here — MinIO serves a one-certificate chain, so the issuer
  cannot be scraped off the wire. Shipping a placeholder would be worse than
  shipping nothing: applied as-is it would make every pod trust the wrong root.
  It is a ROOT_CONFIG_REQUEST (parent README), already raised by TASK-823 §9.1 —
  **but its priority changes here**: for TASK-823 it blocked one un-deployed
  workload at `replicas: 0`; after this ticket it blocks `hope-api`, `hope-stt`
  and `hope-harness`. It is now a platform-wide gate and must land *before* §2.
- **Loki and Tempo already use `10.10.1.102:9000`** and are therefore already
  compliant with the endpoint rule. They connect with verification disabled
  rather than trusting the CA. Worth fixing once `arcaai-internal-ca` exists;
  out of scope here because they carry telemetry, not PHI, and changing them is
  a separate verification.
- **`smoke-test.yaml`** — no check added. The right assertion is "an object
  round-trips over the LAN endpoint", which needs a credential and a scratch
  bucket; wiring that into an Argo `PostSync` hook that gates every sync is a
  bigger decision than this ticket should make unilaterally.
- **TASK-822's `mlflow.env`** carries
  `MLFLOW_S3_ENDPOINT_URL=http://minio.taphuynh.dev:9000` — a *third* MinIO
  hostname, over plaintext HTTP. That handover has not landed either, so it is
  correctable in place rather than as a migration. Flagged to whoever merges it:
  it should be `https://10.10.1.102:9000` with the CA mounted.

## 6. CI gates this must pass in `hope-v2-deployment`

All blocking, none `allow_failure`: `schemas` (kubeconform -strict),
`config-refs`, `envfrom-coverage`, `image-hygiene`, `pull-secrets`,
`patch-hygiene`, `secrets` (gitleaks).

Two that specifically bear on these changes:

- **`config-refs`** validates every non-optional `configMapKeyRef` against the
  rendered ConfigMaps. §2.1 adds one per workload, so §1's `.env` additions are
  not optional — omit them and this gate fails, which is the intended coupling.
- **`envfrom-coverage`** checks that keys a service's code reads are visible to
  its container. `MINIO_ENDPOINT` is already mapped to `[api, stt]` in
  `scripts/env-consumer-inventory.generated.json`; moving it from Secret to
  ConfigMap keeps it visible, so this stays green.

Run `kustomize build deployment/k8s/overlays/dev` locally before pushing.
