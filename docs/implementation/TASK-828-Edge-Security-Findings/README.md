# TASK-828 — Edge and cluster security findings

| | |
|---|---|
| **Status** | Pending — findings recorded, remediation not started |
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

## 4b. ⚠️ P1 — ALL PHI object traffic currently exits to the internet

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
- **Argo CD is itself not under GitOps.** The live `hope-v2-dev` Application declares
  `project: hope-v2` and `automated: {}`; the repo's `application-dev.yaml` declares
  `project: hope-v2-dev` with explicit `prune:false, selfHeal:false`. The Git-declared Application
  **has never been applied**. `application-staging.yaml` / `application-prod.yaml` are registered
  nowhere.
- **Zero NetworkPolicies in `hope-v2-dev`.** Worse than the earlier "is enforcement real?" concern
  — there are no policies at all, so every pod reaches every other pod (Vault, Qdrant, Temporal,
  Postgres-adjacent services included).

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

1. ~~Argo CD~~ — **CLOSED, owner-assigned** (§1).
2. **Repoint in-cluster MinIO consumers to the LAN path** (§4b) — PHI is crossing the internet today, the fix needs no new k8s object, and it is ~248× faster.
3. **Access in front of the data-plane routes** (§4), or remove the routes that need not be public.
4. **Fix Grafana auth + root_url** (§3).
5. Bring the tunnel config under git (§6) — `config_src: "local"` with the config in the deploy repo.
5. Turn off `allow_force_push` on `hope-v2-deployment@main` (§6).
6. Reconcile the Argo Application with its Git declaration (§6).
7. NetworkPolicies (§6), zone TLS posture (§5), then availability (§7).

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-30 | Created from a read-only live-estate review run while establishing MLflow's exposure pattern for TASK-822. |
