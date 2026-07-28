# HOPE — Vault HA on Self-Hosted k3s (TASK-312 Phase C)

Production blueprint for running HashiCorp Vault as a 3-node, highly-available,
auto-unsealing secrets backend on HOPE's self-hosted Proxmox **k3s** cluster.

> Cloud customers (AWS EKS / Azure AKS) reuse this same chart with a per-cloud
> overlay — see Phase D (`aws/`, `azure/`). The **only** thing that changes per
> platform is auto-unseal (KMS vs. Transit) and `role_id` delivery; the app code
> path is identical everywhere.

---

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │  vault-system namespace                       │
                 │                                               │
   Shamir 5/3 ──▶│  ┌────────────┐   transit/encrypt│decrypt    │
   (ops, offline)│  │ vault-seal  │◀─────────────────────────┐  │
                 │  │ (1 node,    │                           │  │
                 │  │  file store)│   auto-unseal token       │  │
                 │  └────────────┘   (Secret vault-seal-      │  │
                 │                     transit)               │  │
                 │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │  │
                 │  │ vault-0  │  │ vault-1  │  │ vault-2  │──┘  │
                 │  │ (leader) │◀▶│(follower)│◀▶│(follower)│     │
                 │  └────┬─────┘  └──────────┘  └──────────┘     │
                 │       │ Raft (integrated storage, :8201)      │
                 │  ┌────▼──────────────┐                        │
                 │  │ agent-injector    │                        │
                 │  └───────────────────┘                        │
                 └───────────────────────────────────────────────┘
            ▲                                   ▲
            │ AppRole login (role_id +          │ k8s-auth (other workloads)
            │ wrapped secret_id, as FILES)      │ → /vault/secrets/*
   ┌────────┴────────┐                 ┌────────┴────────┐
   │ HOPE API (hope) │                 │ annotated pods  │
   └─────────────────┘                 └─────────────────┘
```

- **3-node Raft** integrated storage (no Consul). Quorum tolerates one node down.
- **Transit auto-unseal**: a separate single-node `vault-seal` holds one Transit
  key. The HA cluster unseals itself on every restart — no manual keys, so k8s
  self-healing actually works. The seal Vault is the _only_ Vault sealed by
  Shamir key-shares (held offline by ops).
- **TLS** is mesh-terminated (Linkerd/Istio). If you don't run a mesh, enable
  chart-native TLS before exposing Vault beyond the pod network.

### Pinned versions

| Component                    | Version    |
| ---------------------------- | ---------- |
| `hashicorp/vault` Helm chart | **0.32.0** |
| Vault                        | **1.21.2** |
| `vault-k8s` injector         | **1.7.2**  |

Bump deliberately: Raft on-disk format + seal migration are version-sensitive.

---

## Credential delivery (how the HOPE app authenticates)

HOPE's API authenticates to Vault with **AppRole**, reading its `role_id` and a
one-shot **wrapped `secret_id`** from **files** (`VAULT_ROLE_ID_FILE` /
`VAULT_WRAPPED_SECRET_ID_FILE`, shipped in `apps/api/.env.prod` — TASK-312
B.9/B.10). It then does its own login + token self-renewal (B.1–B.4).

`bootstrap/configure-app-auth.sh` mints those creds into a k8s Secret
(`hope/hope-vault-approle`, keys `role_id` + `wrapped_secret_id`). Mount it into
the API Deployment as files:

```yaml
# apps/api Deployment (excerpt)
volumes:
  - name: vault-approle
    secret:
      secretName: hope-vault-approle
containers:
  - name: api
    volumeMounts:
      - name: vault-approle
        mountPath: /run/secrets/vault
        readOnly: true
    env:
      - name: VAULT_ROLE_ID_FILE
        value: /run/secrets/vault/role_id
      - name: VAULT_WRAPPED_SECRET_ID_FILE
        value: /run/secrets/vault/wrapped_secret_id
```

The wrapped `secret_id` is single-use with a short TTL, so **CI mints a fresh
one per rollout** (re-run `configure-app-auth.sh`, or script the
`secret-id` write into the deploy pipeline) immediately before the pod boots.

> **Why not full agent-injection for HOPE?** The injector is enabled and proven
> (see E2E / AC-C4) for _generic_ workloads via k8s-auth, but HOPE deliberately
> keeps a single, unit-tested secrets path (`SecretsService`) across local dev,
> Docker, and every cloud. The injector only ever delivers the two bootstrap
> files for us; the app does the rest.

---

## Install order

> Prereqs: `kubectl`, `helm`, a k3s/k8s cluster with a default StorageClass and a
> NetworkPolicy-capable CNI (Calico/Cilium — k3s default Flannel does NOT
> enforce NetworkPolicy).

```bash
cd infrastructure/single-deployment/vault

# 0. (once) add the chart repo
helm repo add hashicorp https://helm.releases.hashicorp.com && helm repo update

# 1. seal Vault — root of trust (Shamir, manual unseal by ops)
kubectl apply -k seal-vault/          # PROD: digest-pinned (use -f seal-vault/seal-vault.yaml for unpinned/E2E)
./seal-vault/seal-bootstrap.sh        # prints unseal keys + root token ONCE — store offline

# 2. HA cluster (transit auto-unseal + audit shipper/rotator sidecars)
#    Append -f helm/values.digests.yaml in PRODUCTION to pin images by digest.
helm upgrade --install vault hashicorp/vault --version 0.32.0 \
  -n vault-system --create-namespace \
  -f helm/values.yaml -f manifests/audit-sidecar.values.yaml \
  -f helm/values.digests.yaml

# 3. initialise (recovery keys → Secret) + enable audit
kubectl apply -k bootstrap/           # PROD: digest-pinned (use -f bootstrap/init-job.yaml for unpinned/E2E)
kubectl -n vault-system wait --for=condition=complete job/vault-init --timeout=240s

# 4. app engines/policy/role + AppRole creds for the API
APP_NS=hope ./bootstrap/configure-app-auth.sh

# 5. network + monitoring (apply when the CNI / Prometheus Operator are present)
kubectl apply -f manifests/network-policy.yaml
kubectl apply -f manifests/seal-network-policy.yaml
kubectl apply -f manifests/service-monitor.yaml
kubectl apply -f monitoring/recording-rules.yaml -f monitoring/alerts.yaml  # + import monitoring/grafana-dashboard.json
# (apply monitoring/alerts-app.yaml only after the API exports arca_vault_* — see the runbook)

# 6. run Post-install verification (below), THEN capture recovery keys offline and
#    REVOKE the bootstrap root token (see "Root token lifecycle" below — do NOT skip)
```

> **Day-2 operations** (rotate creds, fail over, recover from quorum loss, monitor,
> chaos drills) live in the operator runbook:
> [`docs/operations/vault/README.md`](../../../docs/operations/vault/README.md).
> Per-(re)deploy `secret_id` rotation without root: `APP_NS=hope ./bootstrap/rotate-secret-id.sh`.

**Order matters**: the seal Vault + its transit token Secret must exist _before_
the HA chart starts, or the HA pods cannot auto-unseal at boot.

### ⚠ Root token lifecycle & break-glass keys

`bootstrap/init-job.yaml` stores the **recovery keys + initial root token** in the
**plaintext** Secret `vault-init-keys` (it lands in etcd unencrypted). Run the
**Post-install verification** below first (it needs the root token), then —
immediately — in **this order**:

```bash
# 1. Copy the recovery material OFFLINE; split the recovery keys among ops (5/3).
kubectl -n vault-system get secret vault-init-keys \
  -o jsonpath='{.data.init\.json}' | base64 -d   # save offline

# 2. REVOKE the bootstrap root token. A long-lived root is the single biggest risk
#    in a Vault deployment; recovery keys can always mint a FRESH temporary root
#    via generate-root, so root is not needed day-to-day. (kind-e2e.sh does this
#    and asserts the token is dead afterwards.)
ROOT=$(kubectl -n vault-system get secret vault-init-keys -o jsonpath='{.data.root-token}' | base64 -d)
kubectl -n vault-system exec vault-0 -- sh -c "VAULT_TOKEN=$ROOT vault token revoke -self"

# 3. The Secret is now a dead credential (recovery keys aside) — delete it.
kubectl -n vault-system delete secret vault-init-keys
```

In production, don't store the recovery material in a k8s Secret at all — front
`init` with sealed-secrets / external-secrets, or capture the Job log offline.

#### Re-running configure-app-auth / rotating the AppRole `secret_id`

Because root is revoked, `configure-app-auth.sh` can no longer read it from the
Secret. When you need privileged access again (mint a fresh wrapped `secret_id`
before a redeploy, add a policy, …), mint a **temporary** root with the recovery
quorum and hand it to the script via `VAULT_TOKEN`:

```bash
# THRESHOLD key-holders cooperate (vault operator generate-root) to produce a
# short-lived root token; see the Vault docs for the OTP/nonce exchange.
VAULT_TOKEN=<temporary-root> APP_NS=hope ./bootstrap/configure-app-auth.sh
# then revoke it:
kubectl -n vault-system exec vault-0 -- sh -c "VAULT_TOKEN=<temporary-root> vault token revoke -self"
```

A dedicated, **narrow** `secret_id`-issuer token (mints `secret-id`s only — no
root) that removes the generate-root dance from routine redeploys is tracked for
**Phase E "Day-2 rotation"**.

---

## Post-install verification

```bash
# all 3 nodes Ready (auto-unsealed + joined)
kubectl -n vault-system get pods -l app.kubernetes.io/name=vault,component=server

# Raft quorum: expect 1 leader + 2 followers, all "voter"
ROOT=$(kubectl -n vault-system get secret vault-init-keys -o jsonpath='{.data.root-token}' | base64 -d)
kubectl -n vault-system exec vault-0 -- sh -c "VAULT_TOKEN=$ROOT vault operator raft list-peers"

# seal status: sealed=false, type=transit
kubectl -n vault-system exec vault-0 -- vault status

# audit device enabled
kubectl -n vault-system exec vault-0 -- sh -c "VAULT_TOKEN=$ROOT vault audit list"
```

### Automated E2E (local kind)

```bash
./test/kind-e2e.sh          # spins a kind cluster, runs the full flow, asserts
./test/kind-e2e.sh --keep   # keep the cluster for inspection
```

Asserts: seal+transit, 3/3 auto-unseal, Raft quorum (3 voters), audit device
enabled (AC-C3), **node-restart auto-unseal + quorum recovery (AC-C2)**, init Job,
AppRole Secret delivery, agent-injector delivering a secret to `/vault/secrets/*`
(AC-C4), and bootstrap **root-token revocation** (verified dead afterwards).

---

## Operations

### Scaling

Raft is a fixed-size voting cluster — **keep it at 3 or 5** (odd, for quorum).
`helm upgrade ... --set server.ha.replicas=5`, then verify new nodes join via
`vault operator raft list-peers`. Do not scale to even numbers.

### Upgrade

Rolling upgrade, **standbys first, leader last** (the chart's `OnDelete`/partition
strategy). Snapshot before any upgrade:

```bash
kubectl -n vault-system exec vault-0 -- sh -c "VAULT_TOKEN=$ROOT vault operator raft snapshot save /tmp/snap.snap"
kubectl -n vault-system cp vault-0:/tmp/snap.snap ./vault-$(date +%F).snap
```

Bump `image.tag` + chart `--version` together; read both CHANGELOGs.

### Seal Vault restart

The seal Vault does **not** auto-unseal. After it restarts, the HA cluster stays
sealed until ops re-unseals the seal Vault:

```bash
kubectl -n vault-system exec vault-seal-0 -- vault operator unseal <key>   # x threshold
```

### Hardening the seal Vault

The seal Vault is the cluster's **root of trust** — its blast radius must be tiny:

- **Shamir 5/3** (the bootstrap script **refuses** `<3/2` unless
  `ALLOW_INSECURE_KEY_SHARES=true`, which is for throwaway test clusters only).
- `manifests/seal-network-policy.yaml` default-denies it and allows ingress **only**
  from the HA server pods on `:8200`.
- The transit token handed to the HA cluster can **only** encrypt/decrypt the one
  `autounseal` key — it cannot read any HOPE secret.
- Prefer running it in its **own namespace + node-pool** (ideally a separate
  cluster). It shares `vault-system` here only to match the seal address in
  `helm/values.yaml`; if you split it out, update that address + this NetworkPolicy.

### Emergency: quorum lost

Restore from the latest Raft snapshot onto a fresh single node, then re-scale.
See the Phase E runbook (`docs/operations/vault/README.md`).

---

## Files

| Path                                                  | Purpose                                                                                  | AC            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------- |
| `helm/values.yaml`                                    | HA Raft + transit seal + injector + audit storage + probes                               | C.2, C.3, C.4 |
| `seal-vault/seal-vault.yaml`                          | single-node seal Vault (Transit root of trust)                                           | C.3           |
| `seal-vault/kustomization.yaml`                       | PROD digest-pin overlay for the seal Vault (`apply -k`)                                  | E             |
| `seal-vault/seal-bootstrap.sh`                        | init/unseal seal Vault, transit key, scoped token → Secret                               | C.3           |
| `bootstrap/init-job.yaml`                             | `operator init` (recovery keys → Secret) + enable audit                                  | C.5           |
| `bootstrap/kustomization.yaml`                        | PROD digest-pin overlay for the init Job (`apply -k`)                                    | E             |
| `bootstrap/configure-app-auth.sh`                     | kv-v2 + transit + AppRole + `hope-app` policy/role + secret_id-issuer token → app Secret | C.4, E        |
| `bootstrap/rotate-secret-id.sh`                       | per-(re)deploy `secret_id` rotation via issuer token (NO root)                           | E             |
| `manifests/network-policy.yaml`                       | restrict Vault server ingress                                                            | C.6           |
| `manifests/seal-network-policy.yaml`                  | lock seal Vault ingress to HA server pods only                                           | C.6           |
| `manifests/service-monitor.yaml`                      | Prometheus scrape of `/v1/sys/metrics` (all nodes)                                       | C.7           |
| `manifests/audit-sidecar.values.yaml`                 | audit log-shipper + copytruncate rotator sidecars (values overlay)                       | C.8, E        |
| `helm/values.digests.yaml`                            | production image digest pins (overlay)                                                   | E             |
| `monitoring/{alerts,recording-rules,alerts-app}.yaml` | PrometheusRules (server-side + app-side)                                                 | E             |
| `monitoring/grafana-dashboard.json`                   | Grafana dashboard ("HOPE — Vault HA")                                                    | E             |
| `test/kind-e2e.sh`                                    | full local E2E on kind                                                                   | C.9           |
| `../../../scripts/chaos/vault-drill.sh`               | chaos drill (leader kill, follower auto-unseal, transit outage)                          | E.2           |
| `../../../docs/operations/vault/README.md`            | **operator runbook** (day-2: rotate, fail over, recover, monitor)                        | E.1           |
