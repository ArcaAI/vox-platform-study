# Simple deployment, integration and configuration — the HOPE object-store playbook

> Owner ask, 2026-08-30: *"Deliver best practices for simple deployment /
> integration / configuration."* This is that deliverable. Every rule below is
> grounded in something in this repository or in `hope-v2-deployment`; where a
> rule has been broken here, the breakage is cited with `file:line` so the rule
> has a worked example rather than an assertion.
>
> Bias throughout: **the simplest thing that works.** A control that needs a
> distribution mechanism, a rotation ceremony and a CI gate to stay correct is
> more expensive than the failure it prevents, unless the failure is real.

---

## 1. Where a value belongs: ConfigMap vs Secret vs database

The repo already answers this, twice, and both answers agree. Follow them
rather than inventing a third.

**The rule** (`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers):
a value stays in **env** only if it is required *to reach the database* or *to
authenticate to Vault*. Everything else is `vault-kv`, `db-config`,
`global-kv`, `redis-flag` or `entitlement`.

**The registry** (`packages/applications/src/services/settings-registry/descriptors/storage.descriptors.ts`)
applies that rule to object storage specifically:

| Value | Declared tier | Physical home |
|---|---|---|
| `storage.platformDefault.endpoint` | `db-config` | SYSTEM `TenantStorageConfig` row (`tenantId = SYSTEM`, `bucketId = NULL`) |
| `storage.platformDefault.region` / `.forcePathStyle` / `.containerPrefix` | `db-config` | same row |
| `storage.platformDefault.credentials` | `vault-kv`, `failMode: 'closed'` | Vault kv-v2 `platform/storage/minio`, reached via `credentialsRef` |
| `minio.endpoint` (`MINIO_ENDPOINT`) | **`env`**, `sensitivity: 'internal'`, `editableBy: 'none'` | deploy-time **bootstrap fallback only**, used before the SYSTEM row exists; logs a WARN when it is the tier that supplied the value |

Read across that table and the decision procedure falls out:

| Question | Answer |
|---|---|
| Does a process need it *before* it can reach the database? | **env** → ConfigMap (or `.env` in the base config, which becomes one). |
| Is it a credential? | **Vault** (`vault-kv` for platform, `db-secret` via `credentialsRef` for tenant). Never a plaintext DB column, and never a k8s Secret if Vault can hold it. |
| Must an admin change it without a redeploy? | **database** (`db-config`), through the SYSTEM row or the tenant's own row. |
| Anything else | it is probably `global-kv`, and if you cannot name which tier it is, it is not ready to be added. |

A k8s `Secret` is the *transport* for the credentials a pod needs at boot. It is
not a tier, and nothing that is not a credential should be in one.

### 1.1 The worked example of getting it wrong

`hope-v2-deployment/deployment/secrets.dev.yaml.example:55`:

```yaml
  # -- MinIO --
  MINIO_ENDPOINT: "minio.taphuynh.dev:9000"
```

An endpoint inside a `Secret`, in the file operators copy from. Four distinct
costs, none of them theoretical:

1. **It is not a secret, and the repo says so** — `minio.endpoint` is declared
   `sensitivity: 'internal'`, tier `env`. Putting it in a Secret moves a
   review-worthy value out of Git, out of review, and out of CI.
2. **It cannot fail closed.** The key already exists with a value. The failure
   mode is not absence but *staleness*, and a stale endpoint fails **open** onto
   whatever it points at — here, a public tunnel hostname that is ~248× slower
   than the LAN path (`infrastructure/docker/minio/README.md` §1).
3. **CI cannot see it.** `config-refs` (`.gitlab-ci.yml:74`) validates every
   non-optional `configMapKeyRef` against the rendered ConfigMaps. A
   hand-applied Secret is invisible to it. The moment the value moves to a
   ConfigMap, a missing key becomes a red pipeline instead of a runtime surprise.
4. **It spreads.** `deployment/k8s/base/stt.yaml:99-103` and
   `stt-worker.yaml:98-102` both pull `MINIO_ENDPOINT` from `hope-secrets`
   because that is where the template put it. One wrong classification in an
   example file becomes the shape of every consumer.

**The fix**: `MINIO_ENDPOINT=10.10.1.102:9000` in
`deployment/k8s/base/config/{api,stt}.env`, referenced as a **non-optional**
`configMapKeyRef`. A missing key then becomes `CreateContainerConfigError` — the
pod refuses to start rather than quietly reaching for the slow public path.
Kubernetes gives an explicit `env:` entry precedence over `envFrom:`, so the
ConfigMap value wins over the stale Secret key with no coordination and no
operator step. The credential pair stays in the Secret, where it belongs.

> This is TASK-832's §0 design decision, restated as a general rule because it
> generalises: **move the non-secret half of a Secret into a ConfigMap and make
> the reference non-optional.** You gain a CI gate and a fail-closed startup for
> the price of one line.

---

## 2. How a new service consumes MinIO

Copy `hope-stt`. Five things, and nothing else.

### 2.1 The five variables

| Variable | Source | Value |
|---|---|---|
| `MINIO_ENDPOINT` | ConfigMap (`<svc>.env`), non-optional `configMapKeyRef` | `10.10.1.102:9000` — host:port, **no scheme** |
| `MINIO_SECURE` / `MINIO_USE_SSL` | ConfigMap, literal | matches what MinIO is actually serving (§2.4) |
| `MINIO_ACCESS_KEY` | Secret `hope-secrets`, `secretKeyRef` | the service account's access key |
| `MINIO_SECRET_KEY` | Secret `hope-secrets`, `secretKeyRef` | the service account's secret |
| `MINIO_<PURPOSE>_BUCKET` | ConfigMap, literal | one bucket per purpose, named in the manifest not derived in code |

`MINIO_ENDPOINT` is scheme-less by convention and the scheme is composed from
the boolean — see `packages/applications/src/services/tenant-storage-config/platform-storage-config.ts:91-94`.
Do not put a scheme in it; a value like `https://host:9000` combined with
`MINIO_USE_SSL` produces `https://https://host:9000` in the clients that
concatenate.

Every new variable must also be added to `turbo.json#globalEnv` and the
service's `.env.sample` (`pnpm env:sync`), or it is an ungoverned config surface.

### 2.2 Path-style addressing is mandatory — set it explicitly

MinIO addressed by **IP** cannot be reached virtual-host style: that form
requires the client to resolve `<bucket>.10.10.1.102`, which is not a name and
never resolves. The failure surfaces as a DNS or `NoSuchBucket` error that
points at the bucket rather than at the addressing mode, which is why it costs
an afternoon rather than a minute.

The platform already pins it in five independent places — match them:

| Where | Setting |
|---|---|
| `packages/applications/src/services/baseServices/storage/providers/s3-blob.provider.ts:65` | `forcePathStyle: config.forcePathStyle ?? true` |
| `packages/applications/src/services/settings-registry/descriptors/storage.descriptors.ts` | `storage.platformDefault.forcePathStyle`, `default: true` |
| `hope-v2-deployment/deployment/k8s/base/observability-config.yaml:735` | Loki `s3forcepathstyle: true` |
| `hope-v2-deployment/deployment/k8s/base/observability-config.yaml:810` | Tempo `forcepathstyle: true` |
| `infrastructure/docker/docker-compose.dev.yml:494-496` | `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING: "0"`, with the comment *"unset, the streamer builds virtual-host-style URLs (`<bucket>.<host>`) and every load dies on DNS"* — this trap has already been paid for once here |

Corollary for naming: dots are safe in **keys** (`qwen3.5-4b/…`) precisely
because addressing is path-style. They are never safe in a **bucket** name.

### 2.3 Region: send `us-east-1` and stop thinking about it

MinIO ignores the region but the AWS SDKs refuse to sign without one. The
platform default is `us-east-1` in three places — `s3-blob.provider.ts:60`,
`storage.descriptors.ts` (`storage.platformDefault.region`), and both
observability backends. Do not invent a new one; a mismatched region produces a
signature error that reads like a credential problem.

### 2.4 Transport: HTTP or HTTPS-without-verification, never a CA

Owner directive: **no private CA anywhere.** MinIO is authenticated by the
service-account key pair, not by a certificate.

That leaves the scheme, and it is settled by what the client libraries can
actually do (measured 2026-08-30, `infrastructure/docker/minio/README.md` §2.1):

| Stack | Plain HTTP | Skip verification |
|---|---|---|
| Python `minio` (STT) | ✅ | ✅ `MINIO_CERT_CHECK=false` (`apps/stt/src/stt/core/storage/minio_client.py:38`) |
| `boto3` (harness) | ✅ `use_ssl=False` | ❌ no `verify=` argument is passed (`apps/harness/src/harness/temporal/claim_check.py:147-153`) |
| `@aws-sdk/client-s3` (api) | ✅ | ❌ no `requestHandler` configured (`packages/applications/src/services/baseServices/storage/providers/s3-blob.provider.ts:58`) |
| `mc` | ✅ | ✅ `--insecure` |

**Plain HTTP is the only option that works everywhere with zero code changes.**
Skip-verify needs two small client factories changed. Both honour the directive;
the choice between them is §5 O-1 and belongs to the owner, because MinIO
currently serves HTTPS and four LAN consumers outside this repo depend on that.

`RELAXED:` neither option verifies the MinIO certificate. Reversing it means
publishing the CA and setting `AWS_CA_BUNDLE` / `SSL_CERT_FILE` /
`NODE_EXTRA_CA_CERTS` per that table.

### 2.5 Do not create buckets at runtime

`apps/stt/src/stt/core/storage/minio_client.py:53-59` calls `ensure_bucket()`
at startup, which creates `hope-audio` / `hope-audio-chunks` on first boot. Two
costs:

- the app credential must hold `CreateBucket`, which is the opposite of least
  privilege and cannot be scoped to a bucket that does not exist yet;
- there is no retry, so a transient storage hiccup becomes a startup crash-loop
  that presents as an application bug.

**Buckets are provisioned once, by the bootstrap (local) or the operator
(cluster). A service reads and writes; it does not create.** Pre-create with
`mc mb --ignore-existing` and give the service a credential that cannot make
buckets.

### 2.6 Presigned URLs: decide the posture before you need it

A LAN-only endpoint means a presigned URL built from `10.10.1.102:9000` is
useless to a browser — and it fails as a hung request, not as an error the
client can report. GitLab, on the same LAN and the owner's stated reference
(`docs/research/configs/gitlab/gitlab.rb`), solves this by never issuing one:
`object_store['proxy_download'] = true` and `registry['redirect']['disable'] = true`
make GitLab stream objects through itself.

HOPE must make the same choice explicitly: **proxy object access through
`hope-api`**, or accept a documented two-endpoint split (LAN for server-side
I/O, public hostname for browser-facing presigned URLs) as
`docs/research/configs/langfuse/` already does. Doing neither means the failure
appears the first time a clinician clicks a download link.

---

## 3. Service-account hygiene

**One account per role, not per consumer.** `hope-models-reader` is held by
every weight consumer; that is correct, because they all want exactly the same
thing. A per-pod credential multiplies rotation work without narrowing anything.
Split only when the *permissions* differ — reader vs publisher do, so they are
two accounts.

**Two layers, and only the lower one rotates.** MinIO separates the identity
(`mc admin user add` + `mc admin policy attach`) from the credential
(`mc admin user svcacct add`). The platform already does this for pgBackRest
(`docs/research/deployments/deploy-vm402-minio.md` §9b.2–9b.3) — copy it:

- the **identity** carries the policy and is named after the job. It is reviewed
  and long-lived.
- the **service account** is the access key + secret a pod actually holds. It
  inherits the identity's policy and is disposable.

Rotation is then: mint a second service account on the same identity, roll the
new pair into config, restart consumers, delete the old key. Both are valid
during the overlap, so there is no restart ordering to get wrong. Commands in
`infrastructure/docker/minio/README.md` §4.2.

**Least privilege, measured not assumed.** The two committed policies
(`infrastructure/docker/minio/policies/`) were run against a real MinIO with the
service-account credentials and all six assertions held: publisher can write and
set retention; reader can list and get; reader cannot overwrite, delete or set
retention; **neither identity can see any other bucket at all.**

Three specifics worth carrying to the next policy you write:

- **Never grant `s3:DeleteObject` to a service.** Retiring data is a root action
  taken knowingly. This is the layer that actually holds — object lock does not
  stop an object disappearing (a delete marker hides it while the bytes survive),
  so the credential is the control, not the bucket setting.
- **Never grant `s3:ListAllMyBuckets` "so `mc ls` works".** MinIO already filters
  the bucket listing by policy — measured: the reader account's `mc ls <alias>`
  returned `hope-models` and nothing else. Granting it would leak every bucket
  name on the host for no gain.
- **Scope the ARN pair, both halves.** Bucket-level actions
  (`ListBucket`, `GetBucketLocation`, `ListBucketMultipartUploads`) take
  `arn:aws:s3:::<bucket>`; object-level actions (`GetObject`, `PutObject`,
  `ListMultipartUploadParts`) take `arn:aws:s3:::<bucket>/*`. Putting one in the
  wrong statement produces an access denial that looks like a credential problem.

**Never reuse the platform pair.** `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` carry
read/write over every bucket. A weight fetch must not hold a credential that can
write `recordings`.

---

## 4. The smallest correct local-dev story, and how it mirrors the cluster

**What must be identical** — because these are what code depends on:

| Identical | Why |
|---|---|
| bucket names | they appear in config and in code paths |
| the two policy JSON documents | dev mounts `./minio/policies:/policies:ro`; the operator copies the same files. One source, two consumers. |
| the `hope-models` prefix layout and `manifest.json` schema | a model published locally must be servable from the cluster unchanged |
| path-style addressing and `us-east-1` | a bug that only appears in one environment is the expensive kind |

**What legitimately differs** — and the difference should be exactly this much:

| | Local dev | Cluster |
|---|---|---|
| Endpoint | `http://minio:9000` (compose service alias) | `10.10.1.102:9000` |
| Bootstrap | `minio-setup` container, re-runs on every `up`, idempotent | a human, out of band |
| Credentials | obvious dev placeholders in `infrastructure/docker/.env` | service accounts minted with `mc admin user svcacct add` |
| Object lock | best-effort; the bootstrap probes and warns | provisioned deliberately at bucket creation |

Two properties make the local bootstrap correct rather than merely present, and
both are worth preserving in anything similar:

1. **It is idempotent.** `mb --ignore-existing`, and `policy attach` failures
   swallowed with `|| true` because "already in effect" is success. Compose
   re-runs it on every `up`.
2. **It refuses to report a success that did not happen.** Object lock cannot be
   added to an existing bucket, so the script probes and prints an actionable
   warning instead of claiming it worked.

**The local bootstrap is not a deployment mechanism.** Editing
`infrastructure/docker/docker-compose.yml` changes no cluster. The two paths are
independent and kept in step by hand — say so at the top of anything that looks
like an init script, as `infrastructure/docker/minio/README.md` does.

---

## 5. Traps already found in this repository

Each of these was discovered here, not imported from general advice.

| # | Trap | Where |
|---|---|---|
| T-1 | **A YAML folded scalar (`>`) turns a shell script into one line, so the first `#` comments out everything after it.** Two separate fixes disabled themselves this way, and from 2026-08-30 no dev machine created any bucket at all. A literal block (`\|`) keeps one command per line. | `infrastructure/docker/docker-compose.yml`, fixed by TASK-832 |
| T-2 | **A double quote anywhere inside a `/bin/sh -c "…"` block closes the argument early.** The offending quote was inside a *comment*. | same file |
| T-3 | **`mc mb --ignore-existing --with-lock` on an existing lockless bucket prints `Bucket created successfully` and exits 0 — with no lock.** Object lock is creation-only. | measured, `minio/README.md` §6 M-2 |
| T-4 | **`mc retention info --default` prints `Object locking is not enabled.` on a bucket that IS locked, and exits 0.** Judge by exit code or behaviourally; the message is the opposite of the truth. | measured, §6 M-1 |
| T-5 | **Object lock does not prevent an object disappearing** — `rm` writes a delete marker and the object leaves every listing while the bytes survive. The credential is the control. | measured, §6 M-4 |
| T-6 | **`mc policy set public` is a deprecated no-op** — prints a hint and exits 0. Two buckets have not had the policy they appear to have. | measured, §6 M-6 |
| T-7 | **Versioning turns a deletion into retention.** `mlflow gc` is MLflow's only hard-delete path; with versioning on it writes a delete marker and the artifact is recoverable forever. `hope-models` wants exactly the opposite. Same product, opposite settings — check which bucket you are on. | TASK-822 F-4 |
| T-8 | **A named volume with a fixed `name:` is shared across compose projects**, so `down -v` on a throwaway project targets the developer's real Postgres volume. | `infrastructure/docker/docker-compose.yml`; TASK-832 §7.4 |
| T-9 | **A k8s Secret carries `kubectl.kubernetes.io/last-applied-configuration` with the whole `stringData` block in cleartext.** Rotating without stripping the annotation does not retire the old values. | `hope-secrets`, confirmed 2026-08-30 |
| T-10 | **Test infra creates a different bucket set from dev infra.** `tests/docker-compose.test.yml` omits `hope-models` and `harness-claim-check`, and its entrypoint is still a folded scalar — one comment away from T-1. | `tests/docker-compose.test.yml:148-156` |
| T-11 | **Four hostnames for one MinIO host**, two of them inside files operators copy from, one dead since 2026-03-17. Naming drift is a configuration bug with a long fuse. | TASK-832 §3.D |
| T-12 | **A gitleaks rule that does not match the file format in use finds nothing and reports success.** The `hope-s3-credentials` rule required `name = value`; Ruby hash-rocket form put a quote in between, so a file with live MinIO keys scanned clean. | `.gitleaks.toml`; TASK-832 §4 |

---

## 6. Checklist for the next service that needs object storage

- [ ] Endpoint in the service's `.env` (ConfigMap), referenced as a **non-optional** `configMapKeyRef` — never in a Secret.
- [ ] Credential pair from `hope-secrets` via `secretKeyRef`; it is a **service-account** key, minted for a role, not the platform pair and not the root key.
- [ ] A policy scoped to exactly the buckets this role touches, with the bucket-ARN and object-ARN statements split correctly, and no `DeleteObject`.
- [ ] `forcePathStyle` / `s3forcepathstyle` / `use_virtual_addressing=0` set explicitly.
- [ ] Region `us-east-1`.
- [ ] Scheme matches what MinIO serves; no CA distributed (§2.4).
- [ ] Buckets pre-created by the bootstrap or the operator — the service does not call `make_bucket`.
- [ ] New variables added to `turbo.json#globalEnv` and the service `.env.sample`.
- [ ] Local dev uses the same bucket names and the same policy documents.
- [ ] If the service hands object URLs to a browser, the presigned-URL posture (§2.6) is decided in writing first.
