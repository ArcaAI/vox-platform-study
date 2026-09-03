# TASK-832 — changes for `hope-v2-deployment` (HANDOVER, not applied)

Authored in the app repo; **the orchestrator makes every commit to
`hope-v2-deployment`** (EXECUTION-PLAN §14.5). Nothing here has been applied
to the cluster or committed to that repo. **Re-verified 2026-08-30: still not
applied** — `stt.yaml:99-105` still reads `MINIO_ENDPOINT` from `hope-secrets`
with `MINIO_SECURE: "false"`, neither `api.env` nor `stt.env` carries an
endpoint, and the repo contains zero NetworkPolicy objects.

Goal: **no in-cluster workload addresses MinIO by a public hostname.**

> ### Owner directives, 2026-08-30 — these supersede the previous revision
> 1. **No private CA.** Authentication is a **service account** (access key +
>    secret). The `arcaai-internal-ca` ConfigMap, the CA volume mount, and the
>    per-runtime `AWS_CA_BUNDLE` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`
>    variables are **all cancelled**. R-1 in the parent README is withdrawn, and
>    with it the platform-wide blocker.
> 2. **PHI is not the argument.** Internalizing the endpoint stands on latency
>    (~248×) and on removing four moving parts from a two-machine hop. Relaxed
>    controls are marked `RELAXED:` so they can be reversed.
> 3. **Simplest thing that works.**

---

## 0. The design decision that shapes everything below

`hope-secrets` is hand-applied and the Argo `AppProject` **blacklists Secrets**
(`appproject-dev.yaml`: `namespaceResourceBlacklist: [{group: "", kind: Secret}]`),
so Argo can never manage it and this ticket cannot change it through GitOps.

The naive plan is "ask the operator to change `hope-secrets.MINIO_ENDPOINT`".
That is the wrong shape, for three reasons:

1. **An endpoint is not a secret.** The repo's own settings registry declares
   `minio.endpoint` as tier `env`, `sensitivity: 'internal'`
   (`packages/applications/src/services/settings-registry/descriptors/storage.descriptors.ts`).
   Keeping it in a Secret puts a non-secret, review-worthy value in the one
   object that is outside Git, outside review and outside CI.
2. **It cannot fail closed.** The key already exists with the tunnel hostname in
   it. The failure mode is not absence, it is *staleness* — and a stale value
   fails *open*, straight back onto the slow public path.
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
  `api.yaml` already uses for `TEXT_URL`/`STT_URL`/`NLP_URL`.
- `config-refs` (blocking CI, `.gitlab-ci.yml:74`) now *proves* the reference
  resolves.
- The credential pair stays in `hope-secrets`, where it belongs.

Net effect: **the operator does not have to touch `hope-secrets` for the
endpoint at all.** They should still correct or delete the stale key (§4), but
correctness no longer depends on their doing so.

---

## ⚠️ Blocked on one decision: the scheme

Directive 1 removes the CA. It does not, by itself, say whether MinIO is
reached over `http://` or over `https://` with verification off. The MinIO host
was given a self-signed certificate (`docs/research/deployments/deploy-vm402-minio.md`
§14) and currently serves **HTTPS on :9000**; MinIO serves one scheme per port.

| | **A — plain HTTP** (the directive, literally) | **B — HTTPS, verification off** |
|---|---|---|
| App-repo code changes | **none** | `verify=False` in `claim_check.py` + a `NodeHttpHandler` in `s3-blob.provider.ts` / `s3.service.ts` |
| MinIO host | drop `--certs-dir`, restart | none |
| Collateral outside these repos | pgBackRest (documented as requiring HTTPS), GitLab, Loki, Tempo, Prometheus, both `cloudflared` origins | none — all already run verification-off |

Every `.env` diff below is written for **A**. The variant for **B** is given
inline. **Do not apply either until the owner picks one** (O-1 in the parent
README) — the two differ by exactly the boolean and one extra key.

---

## 1. Config changes — endpoint + scheme

### 1.1 `deployment/k8s/base/config/api.env`

```diff
-MINIO_USE_SSL=true
+# TASK-832: the LAN address of the MinIO host, replacing the public Cloudflare
+# Tunnel hostname that hope-secrets.MINIO_ENDPOINT still carries. Not a secret —
+# the settings registry declares it `sensitivity: internal`, tier `env` — and it
+# belongs in Git where it can be reviewed. Referenced as a NON-OPTIONAL
+# configMapKeyRef in api.yaml, so a missing key is CreateContainerConfigError
+# rather than a silent fallback to the tunnel.
+MINIO_ENDPOINT=10.10.1.102:9000
+# Option A. For option B leave this `true`.
+MINIO_USE_SSL=false
```

### 1.2 `deployment/k8s/base/config/stt.env`

```diff
 MINIO_AUDIO_BUCKET=hope-audio
 MINIO_CHUNK_BUCKET=hope-audio-chunks
+# TASK-832 — see api.env for the rationale.
+MINIO_ENDPOINT=10.10.1.102:9000
+# Option A: MinIO serves plain HTTP on the LAN, so `false` is correct and the
+# existing `MINIO_SECURE: "false"` literal in stt.yaml can stay.
+# Option B: MINIO_SECURE=true AND MINIO_CERT_CHECK=false — the Python minio SDK
+# then builds an https client with cert_reqs=CERT_NONE
+# (apps/stt/src/stt/core/storage/minio_client.py:38). Do NOT set
+# MINIO_CERT_CHECK=true without a CA; the connection is refused.
+MINIO_SECURE=false
```

> The previously recorded defect stands but its shape changes: `MINIO_SECURE`
> was `"false"` while `MINIO_ENDPOINT` was a **public** hostname, so the SDK
> built `http://s3.taphuynh.dev` and spoke plaintext across the internet. Once
> the endpoint is a LAN `/32`, `false` stops being a defect and becomes the
> intended configuration — which is why the endpoint and the boolean must move
> in the same commit, never one before the other.

### 1.3 `deployment/k8s/base/config/harness.env`

```diff
+# TASK-832 — the claim-check store IS platform object storage. Bootstrap-floor
+# values only; the admin-managed source of truth is the SYSTEM
+# TenantStorageConfig row (see the parent README §Operator procedure, step 5),
+# which the resolver applies over these
+# (apps/harness/src/harness/temporal/claim_check.py:236-256).
+HARNESS_CLAIM_CHECK_ENDPOINT_URL=http://10.10.1.102:9000
+# `secure` is DERIVED from the URL scheme, so there is nothing else to set.
+HARNESS_CLAIM_CHECK_SECURE=false
```

## 2. Deployment changes — the fail-closed reference

Applied identically to `api.yaml`, `stt.yaml`, `stt-worker.yaml`,
`harness.yaml`, `harness-worker.yaml`. Name-based strategic merge only —
CI's `patch-hygiene` job (`.gitlab-ci.yml:185`) **bans index-based JSON6902**
(`/env/5/value`).

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
```

`MINIO_SECURE` is already a literal `"false"` in `stt.yaml:104-105` and needs
no change under option A. Under option B it becomes `"true"` and a
`MINIO_CERT_CHECK: "false"` entry is added beside it.

### 2.2 No CA mount — deliberately

The previous revision of this handover mounted an `arcaai-internal-ca`
ConfigMap into every MinIO consumer and set a per-runtime CA variable. **All of
that is removed** per directive 1. There is no CA ConfigMap to create, no
volume, no volumeMount, and no `AWS_CA_BUNDLE` / `SSL_CERT_FILE` /
`NODE_EXTRA_CA_CERTS`.

`RELAXED:` the MinIO certificate is not verified by any in-cluster client.
Reversing this means publishing the CA as a ConfigMap and adding, per workload:
`hope-api` → `NODE_EXTRA_CA_CERTS`, `hope-stt` → `SSL_CERT_FILE`,
`hope-harness` → `AWS_CA_BUNDLE`, all pointing at the mounted PEM.

## 3. NetworkPolicy

`networkpolicy-minio-egress.yaml` in this directory. **Read its §A header
before doing anything with it** — an egress policy flips the selected pods to
deny-all-egress, and `hope-v2-dev` has never run under any policy. It ships
one fully-derived policy (`hope-stt`) plus one for its worker, and templates for
the rest, with the enumeration method spelled out. Do not apply it as a batch.

Validated 2026-08-30: `kubeconform -strict` → 2/2 valid, and
`kubectl apply --dry-run=server` against a live v1.35 API server accepts both
objects. That proves schema and admission, **not** enforcement — see §A step 1.

There is **no** NetworkPolicy in `hope-v2-deployment` today (re-confirmed
2026-08-30). TASK-823 authored the repo's first one but is **not yet handed
over** — `base/kustomization.yaml` has no `vllm.yaml` entry and the repo
contains no `vllm` manifest at all. Whichever of the two lands first
establishes the convention; both follow the same one, deliberately.

## 4. `hope-secrets` — what the operator must do (Argo cannot)

| Key | Now | Should become |
|---|---|---|
| `MINIO_ENDPOINT` | `s3.taphuynh.dev` | **Delete the key**, or set `10.10.1.102:9000`. After §2.1 nothing reads it — but leaving a public hostname in the platform Secret is a trap for the next service that wires itself up with `envFrom` and no explicit override. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | one pair with read/write over every bucket | Keep for the working buckets. **Add `MINIO_MODELS_ACCESS_KEY` / `MINIO_MODELS_SECRET_KEY`** — the `hope-models-reader` **service account** (`mc admin user svcacct add`, `infrastructure/docker/minio/README.md` §4.1) — for weight consumers. A weight fetch should not hold a credential that can write `recordings`. |

⚠️ `hope-secrets` carries a `kubectl.kubernetes.io/last-applied-configuration`
annotation containing the **entire `stringData` block in cleartext** — every
platform secret, readable by anything that can read the Secret object even when
the viewer masks `data`. Confirmed still present 2026-08-30. **Rotating without
stripping that annotation does not retire the old values.** Not this ticket's to
fix, but any credential change made here is undermined by it.

## 5. Not changed here, and why

- **The `arcaai-internal-ca` ConfigMap is cancelled**, not deferred. It was
  R-1 in the parent README and the platform-wide blocker; directive 1 removes
  the requirement entirely.
- **Loki and Tempo already use `10.10.1.102:9000`** with verification disabled
  (`observability-config.yaml:732-738`, `:806-812`). They are already compliant
  with both the endpoint rule and the no-CA directive. Under option A they would
  need their scheme flipped to insecure HTTP; under option B they need nothing.
  That asymmetry is one more input to O-1.
- **`smoke-test.yaml`** — no check added. The right assertion is "an object
  round-trips over the LAN endpoint", which needs a credential and a scratch
  bucket; wiring that into an Argo `PostSync` hook that gates every sync is a
  bigger decision than this ticket should make unilaterally.
- **TASK-822's `mlflow.env`** carries
  `MLFLOW_S3_ENDPOINT_URL=http://minio.taphuynh.dev:9000` — a *third* MinIO
  hostname. That handover has not landed either, so it is correctable in place
  rather than as a migration. Flagged to whoever merges it: it should be
  `http://10.10.1.102:9000` (option A) or `https://…` (option B).

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
