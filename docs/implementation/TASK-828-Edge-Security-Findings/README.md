# TASK-828 — Edge and cluster security findings

| | |
|---|---|
| **Status** | In Progress — **3 findings closed since the review, 1 was WRONG, the rest stand.** §4b and §4c were remediated by TASK-832 (every in-cluster MinIO consumer is on the LAN address, `hope-stt` speaks HTTPS) and §6's "zero NetworkPolicies" is no longer true (TASK-823/824 landed four). §7's `langfuse/docker-compose.yml` line item **does not hold** — see the correction there. §1 stays closed (owner-assigned). §§3, 4, 5, 6 (tunnel governance · force-push · Argo-not-under-GitOps) and §7 (P3 availability) are untouched, and §7's credential ROTATION — the most urgent item in the document — has not happened |
| **Type** | infrastructure / security |
| **Branch** | `dev-2.2` |
| **Source** | Read-only review of the LIVE estate (Cloudflare, Rancher/k3s, Argo CD, GitLab) on 2026-08-30, prompted by TASK-822's MLflow exposure question |
| **Scope note** | These are **not** TASK-822's to fix. They were found while establishing how MLflow should be exposed, and several are more urgent than MLflow. |

## 0. The estate, in one paragraph

Every internal HOPE hostname on `taphuynh.dev` is a **proxied CNAME to a single Cloudflare
Tunnel** (`arca-dev`, `e917ee9e-…`), which forwards to **k3s NodePorts on `10.10.1.10`**.
Traefik is bypassed entirely — the only `Ingress` object in the cluster is `grafana`, on host
`grafana.local`, which no tunnel route targets, so it is dead. **No public origin IP is exposed
for any HOPE service**, which is the one genuinely strong property of this setup.

Auth is **per-app OIDC and the coverage is partial**, not a uniform edge gate.

## 1. ✅ CLOSED — Argo CD SSO (owner-assigned 2026-08-30)

> **The owner is configuring Entra SSO for Argo CD directly.** Closed here rather than
> tracked, so no agent picks it up and no one waits on it. The finding below stays as the
> record of what was wrong and why it mattered.

### The finding (historical)

**⚠️ P1 — Argo CD was internet-reachable with no SSO**

`argo.taphuynh.dev` is an orange-clouded tunnel route serving the Argo CD UI **directly**. Argo
has **no `oidcConfig` and no `dexConfig`** (`get_settings`), and **no Cloudflare Access
application** covers it. The only credential is the built-in `admin` account.

**This is a full write path to the cluster, exposed to the internet, behind one password.**
Argo can create, patch and delete any resource in `hope-v2-dev`, and it holds the deploy
credentials for the GitOps repo.

**This is the single most urgent item in this document**, and it is more urgent than anything
in TASK-822.

*Correction to a widely-held assumption, including the owner's:* Argo CD does **not** use Azure
Entra today. GitLab and Rancher do; Argo does not.

## 2. Authentication coverage — what is actually true

| Service | Auth | Evidence |
|---|---|---|
| **GitLab** | ✅ omniauth OIDC with Azure AD | `whoami` → `identities: [{provider: "openid_connect"}]`; sign-in page renders an "Azure AD" button |
| **Rancher** | ✅ native Azure AD provider, enabled | `AuthConfig/azuread`: `enabled: true`, app `ac603c34-…`, tenant `187af2bd-…` |
| **Argo CD** | ❌ **none — local admin only** | no `oidcConfig`/`dexConfig`; UI served with no SSO |
| **Grafana** | ❌ **none** | no `GF_AUTH_*` in `grafana.yaml`; admin password is an `optional: true` `secretKeyRef` on a key the repo documents as absent |
| **Cloudflare Access** | ⚠️ Entra IdP registered, **applied to exactly ONE app** (`server.taphuynh.dev`, on a different tunnel) | `/access/apps` returns 1 |
| **oauth2-proxy** | ❌ does not exist anywhere | no Deployment, Service or annotation in either repo or the cluster |

**Two different Entra app registrations are in play** — Rancher `ac603c34-…`, Cloudflare Access
`867397e1-…` — under one tenant `187af2bd-…`.

## 3. P1 — Grafana has no authentication story, and is currently broken anyway

`GF_SECURITY_ADMIN_PASSWORD` is an `optional: true` `secretKeyRef` pointing at a key the repo's
own comment says does not exist, so the admin password is Grafana's default or an unmanaged
UI-set value. `GF_SECURITY_COOKIE_SECURE: "false"`, deliberately, because the origin is plaintext.

Separately it is **broken at its public hostname**: `GF_SERVER_ROOT_URL=https://grafana.local`
while it is served at `grafana-dev.taphuynh.dev`, so `/login` returns Grafana's "failed to load
its application files" page. A root_url patch described in the overlay comments is no longer present.

## 4. P1 — Unauthenticated data-plane routes over the tunnel

None of these has a Cloudflare Access application:

`temporal.taphuynh.dev` (Temporal UI) · `db.taphuynh.dev` / `db-ro` (**Postgres, TCP**) ·
`redis-1` / `redis-2` (**Redis 6379**) · `s3` / `s3-console` (**MinIO**) · `registry.taphuynh.dev`

Two tunnel routes (`rb`, `ha-db`) set `originRequest.access.required = false` — Access explicitly
disabled. On a platform whose Postgres holds PHI, a tunnel-exposed database port with no edge
identity check is the finding that would end an audit conversation early.

## 4b. ✅ CLOSED 2026-08-31 — ALL PHI object traffic currently exits to the internet

> **Remediated by TASK-832** (`arca/hope-v2-deployment@main` `12835e42` — *"no in-cluster workload
> reaches MinIO by a public hostname"*). Verified against the live cluster: ConfigMap
> `hope-stt-config-mkg7dc6khk` carries `MINIO_ENDPOINT: 10.10.1.102:9000`, and the `hope-stt`
> Deployment reads it by an explicit `configMapKeyRef`. No in-cluster workload addresses
> `s3.taphuynh.dev` any more.
>
> **The fix below is SUPERSEDED on one point, and it matters.** It says *"repoint every in-cluster
> MinIO consumer at `https://10.10.1.102:9000`, **mounting the internal CA**"*. There is **no
> internal CA anywhere**, and none is being created — that was an owner decision, not an omission.
> What shipped instead:
>
> | Concern | What actually happened |
> |---|---|
> | Authentication | A MinIO **service account** with a least-privilege policy. Not a CA, not mutual TLS |
> | Transport | **HTTPS with certificate verification disabled** — `MINIO_SECURE: "true"` + `MINIO_CERT_CHECK: "false"` — until a **publicly-trusted certificate** is installed on MinIO. Confirmed on the live `hope-stt` Deployment |
> | The CA question | **Cancelled.** Do not open a ticket for it, and do not re-derive it from this paragraph |
>
> **One question from this finding still has no home.** §4b's reasoning leaned on *"the MinIO leaf
> certificate's SAN already carries `IP:10.10.1.102`"* (repeated at TASK-823 §284). With
> verification disabled that SAN is not currently load-bearing, but it becomes load-bearing the
> moment a publicly-trusted certificate is installed and `MINIO_CERT_CHECK` flips back to `true` —
> a public CA will not issue for a private IP, so the endpoint would have to become a DNS name that
> resolves to `10.10.1.102`. **That is an open owner decision recorded here, and it is deliberately
> NOT filed as a new ticket.** It was previously pencilled in for `TASK-834`, which does not exist.

### The finding (historical)

Found by TASK-823 Phase 2 while proving vLLM's weight loading, 2026-08-30.

**There is no MinIO `Service`, `Endpoints` or `Pod` anywhere in the cluster.** Every
in-cluster client reaches object storage through `s3.taphuynh.dev` — the public
Cloudflare Tunnel hostname from §4, which has no Access application.

So **every consultation recording, generated document and stored artifact leaves the
cluster, crosses the internet to Cloudflare's edge, and comes back** — for a service
sitting on the *same LAN* as the node.

**A LAN path already exists and needs no new Kubernetes object.** The tunnel itself
resolves to `https://10.10.1.102:9000`, a host on the k3s node's own `/24`, and the
MinIO leaf certificate's SAN already carries `IP:10.10.1.102`. This is precisely how
`hope-secrets` already addresses Postgres and Redis.

Measured from inside `hope-text`:

| Path | Latency |
|---|---|
| `s3.taphuynh.dev` (tunnel, via the internet) | **495.6 ms** |
| `10.10.1.102:9000` (LAN) | **2.0 ms** |

**~248× slower, for traffic that never needed to leave the building.** TASK-823 has
already switched its own manifests; **every other MinIO consumer is still on the
tunnel.**

Two consequences beyond latency: PHI transits a third party on every object
operation, and any egress `NetworkPolicy` becomes unwritable, because the rule would
have to allow Cloudflare's entire edge range. On the LAN path it is a single `/32`.

**Fix:** repoint every in-cluster MinIO consumer at `https://10.10.1.102:9000`,
mounting the internal CA. Needs its own ticket — it touches every service that
stores an object.

## 4c. ✅ CLOSED 2026-08-31 — `hope-stt` sends PHI audio over PLAINTEXT HTTP across the internet

> **Remediated.** The live `hope-stt` Deployment now carries, in its own `env:` block (which
> outranks every `envFrom` source, so a stale `hope-secrets` key cannot win):
>
> ```yaml
> - name: MINIO_ENDPOINT     # ← configMapKeyRef → hope-stt-config → 10.10.1.102:9000
> - name: MINIO_SECURE
>   value: "true"
> - name: MINIO_CERT_CHECK
>   value: "false"
> ```
>
> Both halves of the stated fix landed: the LAN endpoint of §4b **and** `MINIO_SECURE: "true"`.
> The audio no longer leaves the cluster, and the hop it does make is TLS. `MINIO_CERT_CHECK:
> "false"` is the deliberate interim posture described in §4b's banner — HTTPS without
> verification, pending a publicly-trusted certificate — **not** a regression to plaintext, and
> **not** a substitute for the CA that was cancelled.

### The finding (historical)

Found by TASK-832, 2026-08-30. **This is the live counter-example to §5's conclusion
below, and it invalidates that reassurance for this client.**

The live Deployment sets `MINIO_ENDPOINT` ← `s3.taphuynh.dev` (the public tunnel) **and
`MINIO_SECURE: "false"`**. The MinIO SDK composes the scheme from `secure`, so it builds
**`http://s3.taphuynh.dev` on port 80** — and the zone has `always_use_https: off`, so
nothing upgrades it.

§5 argues the `flexible` SSL mode is not "PHI in the clear" because every HOPE hostname
is a *tunnel* route and tunnel transport is encrypted independently. **That holds only
for clients that speak HTTPS to the tunnel.** `hope-stt` does not. Consultation audio —
the most directly identifying artifact this platform handles — leaves the cluster
unencrypted.

**Fix:** the LAN endpoint of §4b plus `MINIO_SECURE: "true"`. Both are in TASK-832.

## 7. ⚠️ P1 — Live credentials committed, and the gate was configured not to see them

Found by TASK-832 while verifying the GitLab↔MinIO integration.

**38 real findings across three tracked files**, every one inside
`docs/research/configs/`:

| File | Contains |
|---|---|
| `gitlab/gitlab.rb` | MinIO access/secret keys, **an Azure AD client secret** (L332) |
| `gitlab-runner/config.toml` | **4 GitLab runner authentication tokens**, 10 S3 credential lines |
| ~~`langfuse/docker-compose.yml`~~ | ~~a database password~~ — **THIS ROW IS WRONG. Corrected 2026-08-31** |

> **⚠️ Correction — the third file has never contained a secret.** `docs/research/configs/langfuse/docker-compose.yml`
> was re-read in full (216 lines) together with its complete git history (one commit, `2b05b2f50`,
> the only commit that has ever touched it). **Every** secret-shaped field in it —
> `NEXTAUTH_SECRET`, the `PG_PASSWORD` embedded in `DATABASE_URL`, `CLICKHOUSE_PASSWORD`,
> `MINIO_SECRET_KEY`, `LANGFUSE_INIT_*` — is a `${VAR}` shell-interpolation placeholder, in every
> version that has ever existed. There is no database password in it, live or otherwise.
>
> This matters twice. First, the "38 real findings across three tracked files" headline is
> overstated by one file, and a rotation list built from this table would send someone hunting a
> credential that does not exist. Second, `.gitleaks.toml` carries a **dated, per-file allowlist
> line for this file** alongside the two genuine ones — so the gate is currently blinded to a file
> that never needed it. The two genuine files are unaffected and their findings are re-confirmed
> below; **the rotation urgency is unchanged for them.**
>
> Re-confirmed by direct read, 2026-08-31: `docs/research/configs/gitlab/gitlab.rb:269-270` holds a
> literal `accesskey`/`secretkey` pair and `:365` an SMTP password;
> `docs/research/configs/gitlab-runner/config.toml` holds four distinct `glrt-…` runner tokens
> (`:57`, `:118`, `:186`, `:247`) and three literal `AccessKey`/`SecretKey` pairs
> (`:96-97`, `:162-163`, `:225-226`).

**Two independent reasons the gate reported clean**, both now fixed:

1. **An unbounded path allowlist** — `research/configs/.*` excluded *every file type*
   in that tree, sitting in a block documented as covering "documentation that
   legitimately references rotated/example values". It was excluding live config.
2. **The `hope-s3-credentials` regex could not match Ruby.** Its separator was `[:=]`,
   but hash-rocket form (`'aws_access_key_id' => '…'`) puts a **closing quote between
   the name and the `=`**. The name list also assumed env-var spellings and missed
   GitLab's bare `accesskey` / `secretkey`.

**Current state:** the regex is widened, the unbounded path is narrowed to `.md`, and a
**temporary, per-file, dated** allowlist keeps the gate usable for exactly those three
files. Verified: a **new** file in that tree is now caught.

**Remediation is ROTATION, not the allowlist.** The Azure AD client secret is the most
urgent — it is the same tenant used for GitLab and Rancher SSO. Each allowlist line is
removed as its file is rotated.

## 4d. ⚠️ NEW P1 (2026-08-31) — `hope-api` runs with ALL TLS verification disabled, by a live edit that is not in Git

Found while verifying TASK-803's config-plane alignment against the running cluster.

The live `hope-api` Deployment carries, in its container `env:` block:

```yaml
- name: NODE_TLS_REJECT_UNAUTHORIZED
  value: "0"
```

**It is not in Git.** Grepped both halves of the rendered source on
`arca/hope-v2-deployment@main` (`de8dc03e`): `deployment/k8s/base/api.yaml` does not contain it,
`deployment/k8s/overlays/dev/kustomization.yaml` does not patch it in, and it is absent from the
Deployment's own `kubectl.kubernetes.io/last-applied-configuration` annotation — so it did not
arrive through `kubectl apply` either. It is an out-of-band edit to the live object.

Three things make this worse than the scoped relaxation of §4b/§4c:

1. **It is global, not scoped to MinIO.** `NODE_TLS_REJECT_UNAUTHORIZED=0` is a Node **process**
   flag: it disables certificate verification for *every* outbound TLS connection the gateway
   makes — Vault, any OIDC issuer, any BYOK vendor endpoint (Azure OpenAI, Bedrock, Anthropic,
   OpenAI), any webhook target. The MinIO relaxation everyone agreed to is one host on the LAN;
   this is every host on the internet.
2. **The repo already built the governed mechanism, and this bypasses it.** `MINIO_CERT_CHECK` is
   a registered descriptor (`storage.descriptors.ts`, key `minio.certCheck`), read through
   `minioCertCheckFromEnv` (`platform-storage-config.ts:117`), tested, and declared in the
   `.env.sample` files. `config/api.env` states in as many words that *"the gateway needs no
   cert-check key: its S3 client already resolves `S3_REJECT_UNAUTHORIZED` to false for MinIO and
   builds a `NodeHttpHandler` with `rejectUnauthorized: false`"* — i.e. the gateway's relaxation is
   **per-client and DB-tier by design**. A process-wide flag is the thing that design exists to
   avoid.
3. **Nothing will remove it.** Argo runs with `selfHeal: false` (§6), so it will not be reverted,
   and because it is not in Git it survives every sync while being invisible to review, to the
   `config-refs` gate, and to anyone reading the manifests.

**Fix:** delete the env var from the live Deployment and, if some client genuinely needs a
relaxation the S3 path does not already give it, name that client and relax it there — through a
descriptor, in Git. Do not re-add a process-wide flag.

*Verified 2026-08-31 by reading the live Deployment and both Git sources. **UNVERIFIED:** who added
it, when, and which client it was meant to unblock — none of that is recoverable from the object.*

## 5. P2 — Zone TLS posture

`ssl: flexible` (set 2025-01-31), `always_use_https: off`, `min_tls_version: 1.0`.

**Nuance that matters, and that an earlier review of mine got wrong in the other direction:**
because every HOPE hostname is a *tunnel* route, cloudflared↔edge transport is encrypted
independently of the `ssl` knob, so this is **not** "PHI in the clear over the internet" today.
The real hazards are (a) `vpn.taphuynh.dev` and any future proxied **A-record** origin would be
plaintext Cloudflare→origin, and (b) `flexible` permanently masks a missing-TLS origin, so the
day something moves off the tunnel, nothing warns you.

## 6. P2 — Governance gaps

- **The tunnel config is ungoverned.** `config_src: "cloudflare"` — all 38 hostname→origin routes
  live only in the Cloudflare dashboard. Outside both Git repos, outside CI, outside Argo. **No
  review, diff or audit trail on the edge routing of a PHI platform.**
- **`allow_force_push: true` on `main` of BOTH repos**, including `hope-v2-deployment`, which Argo
  auto-syncs. A force-push there rewrites deployed state with no recoverable history.
- **Argo CD is itself not under GitOps.** *(Re-verified against the live Application 2026-08-31 —
  unchanged: `spec.project: hope-v2`, `spec.syncPolicy: {automated: {}, retry: {...}}`, no `prune`,
  no `selfHeal`.)* The live `hope-v2-dev` Application declares
  `project: hope-v2` and `automated: {}`; the repo's `application-dev.yaml` declares
  `project: hope-v2-dev` with explicit `prune:false, selfHeal:false`. The Git-declared Application
  **has never been applied**. `application-staging.yaml` / `application-prod.yaml` are registered
  nowhere.
- **NEW 2026-08-31 — the Vault unseal shares now live in etcd in this namespace, and §1 is the
  control that stands in front of them.** TASK-833 replaced the external transit seal (whose host
  turned out not to exist) with an in-cluster Shamir seal; three of the five shares sit in Secret
  `hope-vault-unseal`, and Secret `hope-vault-init` holds the initial **root token**. That is
  accepted for a dev namespace and it widens nothing on its own — the root token was already there
  — but it does mean anyone who reaches Argo CD's write path reaches Vault's unseal material. The
  Vault manifest names this dependency explicitly and asks that the two be sequenced together.
  **Hardening still owed, and larger than the shares:** revoke the initial root token
  (`operator generate-root` mints a new one when genuinely needed; the shares authorise it, so
  nothing is lost). Staging and production must NOT inherit this posture — there the seal belongs
  on a KMS the cluster authenticates to with a non-exfiltratable workload identity.
- ~~**Zero NetworkPolicies in `hope-v2-dev`.**~~ **PARTLY ADDRESSED 2026-08-31 — and the residual
  finding is now sharper, not softer.** Four policies exist, all landed by TASK-823/824:
  `hope-vllm-ingress`, `hope-vllm-egress`, `hope-lmstudio-ingress`, `hope-lmstudio-egress`
  (confirmed live). vLLM's egress allows only DNS + `10.10.1.102/32:9000`; LM Studio's allows only
  DNS. **But they cover exactly the two workloads that are scaled to zero.** Every pod that is
  actually running — Vault, Qdrant, Temporal, the six Python services, the gateway — is still
  unpoliced, and reaches every other pod. Two further consequences the original finding did not
  state: the two new policies are also the cluster's first, so **whether k3s is enforcing them at
  all is untested** (TASK-824 carries this as its open `R-5`), and the §4b LAN repoint is what
  makes an egress policy *writable* in the first place — on the tunnel path the rule would have had
  to allow Cloudflare's entire edge range.

## 7. P3 — Availability

`hope-v2` is a **single Ubuntu node** (`dell`, 10.10.1.10) that is simultaneously control-plane,
GPU host and every workload. The PDBs and HPAs in `base/` cannot deliver availability on it.
The `hope-docker` tunnel is **down** since 2026-03-17 while `minio-hope.taphuynh.dev` still
points at it.

Capacity, for planning: 16 CPU / 49 GiB / 110 pods, currently 43 pods and ~10.1 CPU requested.
**GPU: 2× RTX 2000 Ada (~16 GiB each), time-sliced ×3 → `allocatable nvidia.com/gpu: 6`**, 2
requested. **Owner-confirmed 2026-08-30: those two cards are what is assigned to the cluster.**

Relevant to TASK-823, and the constraint is sharper than "2 cards": `mig.capable=false`,
`mps.capable=false`, `vgpu.present=false` — **no isolation mechanism exists on this hardware**, so
time-slicing hands out 6 fungible permits over 2 cards with no VRAM accounting. Two pods on slices
of the same card contend for the same 16 GiB with nothing to stop them. LM Studio also runs on the
node host and holds VRAM entirely outside k8s accounting.

## 8. Suggested order

*Rewritten 2026-08-31 — three items are done, and the original list had duplicate numbering (it ran
3, 4, 3, 4, 5, 5, 6, 7) which made "what is next" genuinely ambiguous.*

**Done, in the order they were actually closed:**

- ~~Argo CD SSO~~ — CLOSED, owner-assigned (§1).
- ~~Fix `hope-stt`'s plaintext PHI path~~ — CLOSED (§4c): LAN endpoint + `MINIO_SECURE: "true"`.
- ~~Repoint in-cluster MinIO consumers to the LAN path~~ — CLOSED (§4b), TASK-832.

**Still open, highest first:**

1. **Rotate the credentials in the TWO genuine files** (§7) — the **Azure AD client secret first**;
   it shares the tenant with GitLab *and* Rancher SSO, so it is the one finding here whose blast
   radius is the identity provider itself. This is still the most urgent item in this document and
   nothing has been rotated. Remove each `.gitleaks.toml` allowlist line as its file is rotated —
   and remove the `langfuse/docker-compose.yml` line regardless, since that file never held a
   secret (§7 correction).
2. **Revoke the Vault initial root token**, and sequence it with the unseal-share exposure (§6).
3. **Remove `NODE_TLS_REJECT_UNAUTHORIZED=0` from the live `hope-api` Deployment** (§4d) — an
   out-of-band edit, not in Git, that disables TLS verification for *every* outbound connection the
   gateway makes, not just MinIO.
4. **Cloudflare Access in front of the data-plane routes** (§4) — Postgres, Redis, MinIO, Temporal
   UI and the registry are still tunnel-exposed with no edge identity check — or remove the routes
   that need not be public.
5. **Fix Grafana auth + `root_url`** (§3) — it has no authentication story and is broken at its own
   public hostname.
6. **Bring the tunnel config under git** (§6) — `config_src: "local"`, config in the deploy repo.
7. **Turn off `allow_force_push` on `hope-v2-deployment@main`** (§6).
8. **Reconcile the Argo Application with its Git declaration** (§6).
9. **NetworkPolicies for the workloads that actually run** (§6 — the four that exist cover only the
   two scaled to zero, and k3s enforcement is still unproven), then zone TLS posture (§5), then
   availability (§7 P3).

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-30 | Created from a read-only live-estate review run while establishing MLflow's exposure pattern for TASK-822. |
| 2026-08-31 | **NEW §4d — `hope-api` runs with `NODE_TLS_REJECT_UNAUTHORIZED=0`, added by a live edit that is not in Git.** Found while verifying TASK-803 against the running cluster. It is absent from `deployment/k8s/base/api.yaml`, absent from `overlays/dev/kustomization.yaml`, and absent from the Deployment's own `last-applied-configuration` — an out-of-band change to the live object. It is a Node PROCESS flag, so it disables certificate verification on every outbound TLS connection the gateway makes (Vault, OIDC, every BYOK vendor endpoint, every webhook target) — not just MinIO. It also bypasses the governed mechanism this repo built for exactly this: `MINIO_CERT_CHECK` is a registered descriptor read per-client, and `config/api.env` states the gateway needs no cert-check key because its S3 client already relaxes `rejectUnauthorized` for MinIO alone. With Argo `selfHeal: false` nothing will revert it, and being outside Git it is invisible to review and to the `config-refs` gate. UNVERIFIED: who added it, when, and which client it was meant to unblock. |
| 2026-08-31 | **Re-checked every finding against the live estate and the repo; three closed, one was WRONG, one grew a new sibling.** **CLOSED:** §4b (all PHI object traffic exits to the internet) and §4c (`hope-stt` sends PHI audio over plaintext HTTP) — both remediated by TASK-832 (`arca/hope-v2-deployment@main` `12835e42`), verified on the LIVE Deployment: `MINIO_ENDPOINT: 10.10.1.102:9000` via `configMapKeyRef`, `MINIO_SECURE: "true"`, `MINIO_CERT_CHECK: "false"`. §4b's stated fix ("mounting the internal CA") is **superseded** — there is no internal CA and none is being made; authentication is a least-privilege MinIO **service account**, and transport is HTTPS with verification disabled until a publicly-trusted certificate is installed. The certificate-SAN question that reasoning rested on is recorded in §4b as an open owner decision with no ticket, since the `TASK-834` it was pencilled in for does not exist. **CORRECTED:** §7's `langfuse/docker-compose.yml` row is wrong — the file was read in full along with its entire one-commit history and every secret-shaped field is a `${VAR}` placeholder; the "38 findings across three files" headline is overstated by one file, and `.gitleaks.toml` carries an allowlist line blinding the gate to a file that never needed it. The two genuine files were re-confirmed line by line and their rotation urgency is unchanged. **PARTLY ADDRESSED:** §6's "zero NetworkPolicies" — four now exist (TASK-823/824), but they cover exactly the two workloads scaled to zero, so every running pod is still unpoliced and k3s enforcement remains untested (TASK-824 `R-5`). **NEW:** §6 gains the in-cluster Vault seal — TASK-833 put three unseal shares and the initial root token in etcd in this namespace, which is accepted for dev but makes Argo's write path the control in front of Vault's unseal material; revoking the root token is the larger owed hardening. §6's "Argo CD is not under GitOps" re-verified unchanged (`project: hope-v2`, `automated: {}`, no prune/selfHeal). §8's ordering rewritten — it had duplicate numbering and listed three items that are now done. |
