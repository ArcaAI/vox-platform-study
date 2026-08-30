# TASK-833 — Move the Vault seal in-cluster and retire the VM Vault estate

| Field | Value |
|---|---|
| **Status** | `Blocked` — manifests done and proven; **Argo CD cannot deliver to `hope-v2-dev` at all** (§4.2), and operator steps are required after that (§7) |
| **Type** | `infrastructure` |
| **Severity** | **Dev is DOWN** — this is the fix for the TASK-808 §9 outage |
| **Repos** | `arca/hope-v2` (this ticket) · **`arca/hope-v2-deployment`** (the manifests: `28aa2a8` — **already pushed**, see §4.2 — then `9425643` + `ccb35a4` on `main`, unpushed) |
| **Owner directives** | 2026-08-30: *"we need in-cluster vault, lets ignore the vault deployed using vm cluster and switch to use the in-cluster vault"* · later same day: VM 434's Shamir shares are **unavailable** → **re-initialise, do not migrate**; all four VMs approved for destruction once the in-cluster Vault is verified healthy |
| **Operator runbook** | `hope-v2-deployment/docs/vault-seal-migration.md` |

## 1. Why

`hope-vault-0` in `hope-v2-dev` auto-unsealed with a **transit seal against an external VM**,
`https://10.10.1.134:8200`. That VM's Vault is **sealed**, so:

```
error parsing Seal configuration … PUT https://10.10.1.134:8200/v1/transit/encrypt/hope-vault-k3s
→ Code: 503 … * Vault is sealed
```

`hope-vault-0` → `CrashLoopBackOff` (restartCount **541** as of 2026-08-30T10:43Z, unready
since **2026-08-28T11:52:20Z**) → Service has no endpoint → DNS fails → `hope-api` fail-closes
(`getaddrinfo ENOTFOUND hope-vault`) → **`0/2` for two days**.

**TASK-804 adopted the transit seal so that *"unsealing needs no keys and no human"*.** That is
true of `hope-vault-0` and false of the seal Vault it depends on — the single point of failure
**moved rather than disappeared**, and it is off-cluster, so nothing in Argo, the pipeline or the
repo can recover it.

### 1.1 Two corrections to the ticket as opened

**The storage backend is `storage "file"`, not Raft.** There is no `vault operator raft snapshot`
— a backup is a copy of the PVC directory. The seal question is unaffected; the backup procedure
is different and the runbook says so.

**The outage is bigger than `hope-api`.** `10.10.1.134` holds **two** transit keys:
`hope-vault-k3s` (for `hope-vault-0`) and `autounseal` (for the 3-node Raft cluster,
`vault-1/2/3` on VMs 430-432). Prometheus shows all three Raft nodes unreachable — last
successful scrape `2026-08-28 04:56:57Z`, first failed `2026-08-28 11:56:57Z`, bracketing
`hope-vault-0`'s `11:52:20Z`. **One VM sealing took down the entire HOPE Vault estate.**

## 2. The decision

**Shamir seal, unsealed in-cluster by a `vault-bootstrap` sidecar.**

| Option | Verdict |
|---|---|
| **Shamir + in-cluster unseal** | **CHOSEN.** Everything needed to start Vault is inside the namespace. Cost: shares in an etcd Secret. |
| A second in-cluster Vault as transit seal | **REJECTED.** It renames the question rather than answering it — something must still unseal the sealer — and rebuilds the exact failure shape we are fixing, *inside* one namespace. |
| Shamir, manual unseal | **REJECTED.** Every pod restart, node reboot and eviction becomes an outage that waits for a human, and the shares get lost — which is what happened before TASK-804. |

**Sidecar, not a Job** — the `hope-vault-init` Job is deleted. A Job runs **once** while unsealing
is needed on **every** pod start; as an Argo `hook: Sync` at wave 1 a failure **wedges the whole
Application** (it did, for days, in August 2026); and it waited on `http://hope-vault:8200`, a
name the headless Service does not publish while the only pod is NotReady — so **it could never
have bootstrapped a fresh namespace at all.** On `127.0.0.1` that deadlock cannot arise.

### 2.1 Residual risk — recorded at the manifest, not only here

The unseal shares live in Secret `hope-vault-unseal` in `hope-v2-dev`. Accepted **for a dev
namespace** because it widens nothing: **verified against the live cluster 2026-08-30** —
Secret `hope-vault-init` already exists (created `2026-08-25T08:36:27Z`, `manager: kubectl-create`)
with data keys `init.json` and **`root_token`**. Anyone who can read Secrets there could already
read every secret out of a running Vault. The root token is the larger exposure; §6 revokes it.

**Staging and production must not inherit this** — there the seal belongs on a KMS the cluster
authenticates to with a workload identity it cannot exfiltrate.

### 2.2 Interaction with TASK-828

TASK-828 §1 is **CLOSED** (Entra SSO for Argo is being configured). Until it lands,
`argo.taphuynh.dev` is internet-reachable behind one local `admin` password, and an Argo admin
can reach any Secret in `hope-v2-dev`. This seal choice does not create that exposure and does
not depend on it being fixed — the root token was already reachable the same way — but the two
should be sequenced together. The dev `AppProject` **blacklists `Secret` outright**, so unseal
material is out-of-band by construction.

## 3. What was built

### 3.1 `28aa2a8` — the seal change

| File | Change |
|---|---|
| `deployment/k8s/base/vault.yaml` | Transit seal removed → Shamir. New `vault-bootstrap` sidecar. `hope-vault-init` Job deleted. Role narrowed with `resourceNames`. `serviceAccountName: hope-vault-init` on the StatefulSet. |
| `deployment/secrets.dev.yaml.example` | Documents `hope-vault-unseal`; retires `hope-vault-seal`. |
| `docs/vault-seal-migration.md` | The operator runbook. |

**`command: ["vault"]` is explicit on purpose.** `hashicorp/vault`'s entrypoint rewrites `server`
to always prepend `-config="$VAULT_CONFIG_DIR"`, so passing an explicit `-config=<file>` through
it loads the config **twice** and Vault dies on a duplicate listener (`bind: address already in
use`). **Re-verified in this review** against `hashicorp/vault:1.18.3`: exactly one
`Listener 1: tcp (addr: "0.0.0.0:8200" …)`, clean start.

### 3.2 `9425643` + `ccb35a4` — the review pass (§4)

## 4. Review findings against `28aa2a8`

The seal decision and the shape of the change are sound. Three defects in the sidecar were not,
and the runbook was missing the half of the procedure the owner has now chosen to run.

| # | Finding | Verdict |
|---|---|---|
| **R-1** | **Data-loss bug.** On any failure of the Secret write after `sys/init`, the script logged `will retry` and then did not — it fell through to `unset result`, and the next iteration took the `initialized:true` branch. Vault ends up initialised, sealed, shares discarded: **permanently unrecoverable.** That is the 2026-08 "shares were lost" incident, recreated by the mechanism written to prevent it. | **CONFIRMED, reproduced, fixed** |
| **R-2** | **Cold start depended on kubelet timing.** After init the sidecar fell through to the *mounted-file* path, but the `unseal` volume is `optional: true` and did not exist at admission, so kubelet populates it up to a `syncFrequency` later. Measured: **67s** sealed on a fresh namespace, all of it `hope-api` downtime. | **CONFIRMED, fixed → 2s** |
| **R-3** | **No pre-flight.** A broken Role meant `sys/init` ran anyway and the shares had nowhere to go. Initialising is the one irreversible act in the script and it was performed before proving it could be recorded. | **CONFIRMED, fixed** |
| **R-4** | **BestEffort QoS** (`resources: {}`) on the pod that holds the only copy of the unseal shares in memory for a few seconds, on a node with a prior DiskPressure eviction wave. | **CONFIRMED, fixed** |
| **R-5** | *"It widens nothing — `hope-vault-init` already holds the root token"* | **VERIFIED TRUE** against the live cluster (§2.1). Recommendation to revoke carried through into runbook §10. |
| **R-6** | `prune: false` → the deleted Job and its pod linger | **CONFIRMED.** Enumerated as operator actions in runbook §10, including `hope-vault-init-5q6dn`, both `hope-vault-wipe*` pods and `hope-vault-seal`. |
| **R-7** | Readiness probe, `command: ["vault"]`, unreferenced `hope-vault-seal` | **CONFIRMED SOUND.** Probe correctly leaves a sealed Vault NotReady; no `livenessProbe` (which would kill it mid-unseal) is correct; the `seal-ca` volume and `VAULT_TRANSIT_SEAL_TOKEN` env var are both gone, so `hope-vault-seal` is genuinely unreferenced. |
| **R-8** | **The runbook understated Path F by an order of magnitude** (§5). | **CORRECTED** |
| **R-9** | Two writers: the StatefulSet uses a **static** PVC, not a `volumeClaimTemplate`, so `scale --replicas=2` puts two Vault processes on one file store. Pre-existing, not introduced here. | **DOCUMENTED**, not changed (no in-manifest guard exists) |
| **R-10** | **`28aa2a8` was already pushed, and Argo has not applied it.** The ticket recorded it as unpushed; `origin/main` has carried it for hours. The cluster has not moved. | **CONFIRMED — see §4.2. This is now the top blocker.** |

### 4.1 R-1 reproduced, and then fixed — actual output

Faithful harness: the real `hashicorp/vault:1.18.3` and `alpine/kubectl:1.34.1` images, `vault.hcl`
and the sidecar script extracted **verbatim** from the committed manifest, sharing a network
namespace so `127.0.0.1` is Vault (as in the pod), with a stand-in kubectl whose writes can be
made to fail.

**The committed `28aa2a8` script, with the API server refusing writes:**

```
[vault-bootstrap] uninitialised - performing Shamir init (5 shares, threshold 3)
[vault-bootstrap] FAILED to write Secret hope-vault-unseal - will retry
[vault-bootstrap] FAILED to write Secret hope-vault-init - will retry
[vault-bootstrap] sealed, but no shares are mounted … - waiting     ← forever, even after recovery
sys/init     → {"initialized":true}
seal-status  → "sealed":true
Secrets stored: 0                                                    ← the store is now unrecoverable
```

**The fixed script, same failure, same recovery:**

```
[vault-bootstrap] FAILED to write Secret hope-vault-init (attempt 1) - retrying in 10s; material still held in memory
[vault-bootstrap] FAILED to write Secret hope-vault-init (attempt 2) - retrying in 10s; material still held in memory
[vault-bootstrap] FAILED to write Secret hope-vault-init (attempt 3) - retrying in 10s; material still held in memory
>>> API server recovers <<<
[vault-bootstrap] Secret hope-vault-init written
[vault-bootstrap] Secret hope-vault-unseal written
[vault-bootstrap] unsealing with the freshly generated shares
[vault-bootstrap] UNSEALED
```

The three fixes: `store_or_retry()` retries until the write lands and never discards the material;
the **raw** bundle is written to `hope-vault-init` *before* the shares are parsed, so a parse
failure can no longer throw away a generated bundle; and a `kubectl apply --dry-run=server`
pre-flight runs the real authorization path *before* `sys/init`.

**R-3, pre-flight, with RBAC denied from the start:**

```
[vault-bootstrap] REFUSING TO INITIALISE: cannot write Secrets hope-vault-unseal / hope-vault-init.
sys/init → {"initialized":false}      /vault/data entries: 0      ← nothing damaged, retries every 15s
```

### 4.2 ⚠️ R-10 — Argo CD cannot deliver to `hope-v2-dev`, so nothing has changed in the cluster

**This outranks everything else in the ticket.** `28aa2a8` is already on `origin/main` (the
ticket recorded it as unpushed; it is not) and **the cluster has not moved**: live ConfigMap
`hope-vault-config`, `resourceVersion 34038976`, still carries the `seal "transit"` stanza, and
`hope-vault-0` still runs the old `/bin/sh -c … sed … exec vault server` spec.

Argo CD Application `hope-v2-dev` — all **106** tracked resources `Unknown`, `sync: Unknown`,
`health: Progressing`:

| | Condition | Detail |
|---|---|---|
| **A-1** | `ComparisonError`, `reconciledAt 2026-08-30T11:07:41Z` | `Failed to load target state: failed to generate manifest … dial tcp 10.43.14.10:8081: connect: connection refused` — **the Argo repo-server is down.** Argo cannot render desired state, so it can sync nothing. |
| **A-2** | Last sync operation `Failed`, `2026-08-25T17:16:38Z`, retried 3× | `Job.batch "hope-db-migrate" is invalid: [spec.selector: Required value, … field is immutable]` |

**A-2 is a real defect in the dev overlay.** It strips the hook annotations off
`hope-db-migrate` and adds `sync-options: Replace=true`, reasoning that a plain-resource Job
cannot be PATCHed because `spec.template` is immutable. That much is true — but `Replace=true`
alone makes Argo issue `kubectl replace`, which is still an **UPDATE**, and a Job the API server
created carries a generated `spec.selector` (`batch.kubernetes.io/controller-uid`) that the Git
manifest does not have. It traded one permanent sync failure for another. The fix is
`Replace=true,Force=true` (delete + create). **Separate ticket — deliberately not changed here.**

And since **a sync where one task is invalid fails the entire operation** (the dev `AppProject`
comment records the same shape blocking all 109 resources before), A-2 alone is enough to stop
the Vault change landing even once A-1 is repaired.

**What this means for the plan.** The manifests are correct and proven (§6), but pushing them
does not by itself end the outage — and starting the runbook's §3 wipe while the StatefulSet
still carries the transit spec would produce a Vault that crash-loops on an unreachable seal
Vault instead of initialising: a second, self-inflicted outage. Runbook §0.1 now gates the wipe
on this, with a one-line check:

```sh
kubectl -n hope-v2-dev get cm hope-vault-config -o yaml | grep -c 'seal "transit"'   # must be 0
```

Order of operations is therefore: **repair Argo (A-1, then A-2) → confirm `28aa2a8`+ has landed
→ then §3.** If the outage must end sooner, a one-off out-of-band
`kubectl apply -k deployment/k8s/overlays/dev` is the alternative — a deliberate live-cluster
action outside GitOps that needs the owner's explicit approval, and not this ticket's
recommendation.

## 5. ⚠️ What the wipe actually costs — the finding that changes the plan

The owner's Path F decision makes this load-bearing, and `28aa2a8`'s runbook did not state it.

**`scripts/vault-seed-secrets.sh` restores the 23 KV secrets and nothing else.** It writes
`secret/data/hope/<NAME>` for every `vault-kv` descriptor in `PLATFORM_SECRET_SETTINGS`
(derived, never hardcoded — it fails rather than falling back to a stale list). It does **not**
create mounts, transit keys, auth methods or policies.

**A freshly initialised non-dev Vault has none of those.** No `secret/` mount, no `transit/`, no
`approle/`, no policies. So the previous runbook's "R4. Re-seed" would have failed on the first
`vault kv put`, and `hope-api` could not have logged in at all. Runbook **§5 is new** and
provisions the whole surface (`kv-v2` at `secret/`, `transit/` + both keys, `approle` + the
`hope-app` policy from `infrastructure/docker/configs/vault/policies/hope-app.hcl` + the role).

**And the part that is not recoverable at all:** the wipe destroys the transit keys
`hope-phi` and `hope-globalsetting`. They are referenced by **20 repositories**
(`packages/domains/src/repositories/generated/core/*.encryption.ts` — `AuditLog`, `ContextItem`,
`ContextItemVersion`, `DnaWritingStyle*`, `GlobalSetting`, `Highlight`, `KnowledgeChunk`,
`NamedEntity`, `Notification`, `PromptTemplate`, `SummaryMeta`, `TranscriptionJob`, …), and
`base/api.yaml` sets `SECRETS_PROVIDER: "vault"`, which puts `phi-field-encryption.ts` in
**required (fail-closed)** mode — so those columns are genuinely written encrypted here.
`hope-v2-deployment/docs/deployment-runbook.md` §11 records a real
`ContextItem.encryptedContent` row of 1681 bytes decrypting to 1225 bytes of clinical transcript.

A new key of the same name is **different key material**. Every `vault:vN:…` value already in
Postgres becomes permanently undecryptable, and the read path raises rather than degrading — so
this needs a deliberate decision per model (null the column vs. delete the row) *before*
`hope-api` serves those endpoints. Runbook §8.

**The only backup of those two keys is `secret/hope-recovery/*` inside the Proxmox HA cluster on
VMs 430-432** (`deployment-runbook.md` §11.1 — a verified, round-tripped backup). It is currently
unreachable because that cluster auto-unseals against VM 434. **Runbook §11.1 therefore asks for a
Proxmox disk snapshot of all four VMs before they are destroyed.** "The shares are lost" and "the
disks are gone" are different claims, and only one of them is reversible.

Third category, easy to miss: any secret **rotated inside Vault and never written back to
`.env.dev`** is gone (§6 seeds the env-file value over it), as is the operator-written JSON at
`platform/storage/minio` — a `vault-kv` descriptor the seed script deliberately excludes because
its *value* is a KV path, not credential material.

## 6. Verification — actual output, not assertions

All against the real `hashicorp/vault:1.18.3` and `alpine/kubectl:1.34.1`, using `vault.hcl` and
the sidecar script extracted verbatim from the committed manifest.

**Cold start from an empty volume — the Path F proof:**

```
volume entries before start: 0
Vault: Listener 1: tcp (addr "0.0.0.0:8200" …)   ← exactly one; command:["vault"] is correct
[vault-bootstrap] uninitialised - performing Shamir init (5 shares, threshold 3)
[vault-bootstrap] Secret hope-vault-init written
[vault-bootstrap] Secret hope-vault-unseal written
[vault-bootstrap] unsealing with the freshly generated shares
[vault-bootstrap] UNSEALED
### UNSEALED after 2s
{"type":"shamir","initialized":true,"sealed":false,"t":3,"n":5,…,"storage_type":"file"}
/vault/unseal at that moment: 0 entries      ← proves no dependency on kubelet propagation
readinessProbe GET /v1/sys/health?standbyok=true → HTTP/1.1 200 OK
```

**Survives a pod delete with no re-init and no human** (both containers destroyed, PVC + Secret
kept — the DoD acceptance test):

```
### RE-UNSEALED after 2s, no human action
[vault-bootstrap] started; seal is shamir, shares are read from /vault/unseal
[vault-bootstrap] sealed - submitting shares from /vault/unseal
[vault-bootstrap] unsealed                     ← note: NO "performing Shamir init"
readinessProbe → HTTP/1.1 200 OK
canary read back through the restarted Vault: COLD-START-CANARY
```

**Fail-closed, re-verified after the review changes** — a store initialised under a transit seal,
started with the committed pure-Shamir config:

```
Error initializing core: cannot seal migrate from "transit" to Shamir, no disabled seal in configuration
exit code 1
/vault/data: 34 files, md5 c39d7bf33bcfae5eff9e83dac1f9c3ff   ← identical before and after
             …and still identical after four consecutive crash-loop restarts
```

**Build + rules + secret hygiene:**

```
kubectl kustomize deployment/k8s/overlays/{dev,staging,prod}  →  all BUILD OK (dev: 106 resources)
  rendered: StatefulSet/hope-vault has containers [vault, vault-bootstrap] with resources set,
            serviceAccountName hope-vault-init, and NO Job/hope-vault-init
promtool check rules  →  SUCCESS: 35 rules found
promtool test rules   →  SUCCESS  (the repo's own alert-rules.test.yml)
gitleaks 8.30.1 dir . -c <monorepo .gitleaks.toml>  →  no leaks found
gitleaks 8.30.1 dir . (stock default config)        →  1: secrets.dev.yaml.example:52
```

The single stock-config finding is **pre-existing and untouched** — the seeded dev
`API_GATEWAY_KEY` fixture the file deliberately documents. `git diff` touches that file's line 52
zero times. The deployment repo has no `.gitleaks.toml` of its own; under the monorepo's config
(the repo-owned ruleset) it is clean.

## 7. Handover — what the owner must do

Full procedure: `hope-v2-deployment/docs/vault-seal-migration.md`. It is ordered and each step is
verified; the summary is:

1. **Back up** (§2): Secrets `hope-vault-init` / `hope-vault-seal` / `hope-secrets`, plus a tar of
   the PVC. Cheap, and the only thing that keeps Appendix A alive.
2. **Confirm §1 with the owner in writing** — specifically §1.2 (the transit keys) and the "was
   anything rotated in Vault and not written back to `.env.dev`?" question.
3. **Wipe** (§3): scale to 0 → wait for `NotFound` → delete both bootstrap Secrets → wipe pod →
   **verify `entries=0`** with a separate pod. Do not scale up on a partially wiped store.
4. **Cold start** (§4): scale to 1; the sidecar inits and unseals itself. `hope-vault-0` is
   **`2/2`**, not `1/1` — the sidecar is a second container. Copy `hope-vault-init` off-cluster.
5. **Re-provision** (§5): mounts, both transit keys, AppRole + policy. Decide `exportable`
   deliberately — it is irreversible once on.
6. **Re-seed** (§6) and **re-credential `hope-api`** (§7). Note `API_KEY_PEPPER` changing
   invalidates every issued API key at once.
7. **Triage the undecryptable rows** (§8) before serving traffic.
8. **Verify** (§9) — seven checks; the acceptance one is `kubectl delete pod hope-vault-0` → back
   Ready with no human action and **no** `performing Shamir init` in the log.
9. **Clean up by hand** (§10) — `prune: false` means Argo deletes nothing.
10. **Then, and only then, the VMs** (§11) — snapshot first, and move the three monitoring edits
    in one commit.

## 8. ⚠️ Before `10.10.1.130/131/132/134` are destroyed

Two things, both in runbook §11 and neither undoable:

* **Snapshot all four VM disks.** 430-432 hold `secret/hope-recovery/*`, the only backup of the
  two transit keys in §5.
* **Move the monitoring configuration in the same commit as the destruction**, or it alerts
  forever:

| Config | If left pointing at dead hosts |
|---|---|
| `observability-config.yaml` scrape job `vault` → `10.10.1.130/131/132:8200` | `TargetDown` (severity `ticket`) fires **permanently, ×3** |
| `alert-rules.yaml` `VaultSealed` / `VaultQuorumRisk` | Series disappears → they go **silently inert**. The `vault_storage` group then looks like coverage and provides none |
| `alert-rules.yaml` `ExpectedTargetCountMismatch` (`count(count by (job)(up)) < 26`) | Removing the scrape job drops the count to 25 → **fires permanently** unless changed to `< 25` in the same commit |

Both live files are now annotated in place with exactly this, so the instruction is at the code
and not only in a document.

**There is no alert on `hope-vault` itself.** It is not scraped at all; `vault_core_unsealed` only
ever described the VMs. After the teardown the only Vault alerting in the platform is the generic
`PodCrashLooping` / `ContainerWaitingOnError` / `DeploymentReplicasUnavailable`. That is how this
outage ran for two days. **Closing it is a follow-up ticket** (Vault telemetry stanza +
`unauthenticated_metrics_access` + a `HopeVaultSealed` rule).

Two smaller follow-ups deliberately not done here:
* `hope-vault` is a single replica on a static PVC (R-9): `scale --replicas=2` would put two Vault
  processes on one file store. Pre-existing; no in-manifest guard exists.
* HA is genuinely lost by retiring the VM cluster — single node, single PVC, no quorum, no Raft
  snapshot. Accepted for dev; **must not** be carried to staging/prod.

## 9. `infrastructure/single-deployment/vault/` — retired, not deleted

The 3-node Raft blueprint targets VMs that will not exist. It is **kept** rather than deleted, and
marked with a retirement banner, because it is the only written record of a reviewed,
`kind`-tested HA Vault design and three of its parts are still live assets:
`bootstrap/configure-app-auth.sh` (the reference for the exact Vault surface runbook §5
re-provisions), the per-service policy set (mirrored in
`infrastructure/docker/configs/vault/policies/`), and the never-applied `monitoring/` rules — which
are precisely the gap §8 describes.

Banners added to `infrastructure/single-deployment/README.md`,
`infrastructure/single-deployment/vault/README.md` and `docs/operations/vault/README.md`; the
inventory line in `infrastructure/README.md` now says RETIRED and points at the in-cluster
manifest. Left alone deliberately: `docs/archive/**` and `docs/research/**` (off-limits this
sprint) and `docs/operations/vault/vm-cluster-seal-unseal.md`, which is reached through the
banner on its parent README.

## 10. Definition of Done

- [x] Seal mechanism chosen, justified, alternatives rejected in writing (§2, and at the manifest)
- [x] Residual risk stated at the manifest, and the "widens nothing" claim **verified** (§2.1)
- [x] TASK-828 interaction stated explicitly (§2.2)
- [x] No unseal material in Git; gitleaks run with the repo-owned config and reported (§6)
- [x] Fate of every pre-existing object recorded, incl. what an operator must delete by hand (§7, runbook §10)
- [x] Adversarial review of `28aa2a8`; data-loss path found, reproduced and fixed (§4)
- [x] **Cold start from an empty PVC proven**: init → self-unseal → Ready, no human (§6)
- [x] **Survives a pod delete with no re-init and no human** — proven in a faithful harness (§6)
- [x] Landing the commit is non-destructive: fail-closed, `/vault/data` byte-identical (§6)
- [x] What re-seeding does and does **not** restore, stated precisely (§5, runbook §1)
- [x] `infrastructure/single-deployment/vault/` marked retired, losses named (§9)
- [x] Monitoring targets that would alert forever identified and annotated in place (§8)
- [ ] **Argo CD able to sync `hope-v2-dev` at all** — **blocked on §4.2 (A-1 repo-server, A-2 hope-db-migrate)**
- [ ] `hope-vault-0` Ready **in the cluster** with no external dependency — **blocked on §4.2, then §7**
- [ ] `hope-api` reaches `2/2` — follows from the above
- [ ] Transit keys re-created and the undecryptable rows triaged — **blocked on §7 step 7**
- [ ] VMs snapshotted, then destroyed, with the three monitoring edits in one commit — **blocked on §8**

## 10b. The Vault UI and the reset signal (owner asks, 2026-08-30)

Two follow-on asks landed on top of the seal change. Both are in `hope-v2-deployment`.

### 10b.1 The Vault UI — already enabled; the question was access

`ui = true` has been in `vault.hcl` since `28aa2a8`. Verified against the real
`hashicorp/vault:1.18.3`: `GET /ui/` → **200** (Ember app, 996 KB), `GET /` → **307** to
`/ui/`. **No manifest change was needed to enable it.**

**Recommendation: `kubectl port-forward pod/hope-vault-0 8200:8200`, documented in
`docs/vault-seal-migration.md` §12. Do not add a tunnel hostname.** The reasoning is the
estate's, not a general preference:

* `hope-vault` is a **headless** Service with no NodePort, LoadBalancer or Ingress, and the
  Cloudflare Tunnel reaches this cluster through NodePorts (TASK-828 §0). A
  `vault.taphuynh.dev` is not a re-point of an existing route — it means **publishing a new
  Service for Vault**, i.e. adding exposure that does not exist today.
* **Cloudflare Access covers exactly ONE application in the entire estate** (TASK-828 §2).
  Every other HOPE route — including Postgres and Redis over TCP — has no edge identity check.
  A route added the way the existing ones were added puts the secrets plane of a PHI platform
  on the internet behind nothing.
* Argo CD already sits on the internet with full write to this namespace behind one local
  `admin` password until the owner's Entra SSO lands (TASK-828 §1). Adding a second
  internet-reachable path to the same blast radius in the same week is the wrong direction.
* `port-forward` adds **no** attack surface: authenticated by Rancher's Azure AD, point-to-point,
  alive only while the command runs.

One detail that matters in practice and is documented: **forward the POD, not the Service.**
The readiness probe answers 503 while Vault is sealed, so the headless Service publishes no
endpoint in precisely the state where the UI is most wanted.

If a tunnel route is ever wanted it needs three things landing together — a NodePort/Ingress
Service, a Cloudflare Access application over it bound to the Entra IdP *before* the route is
enabled, and TLS to the origin (Vault runs `tls_disable = true` today). §12.3 records that.

### 10b.2 "Initialise Vault" was incomplete — the sidecar now provisions the surface

The ask was for one signal covering Vault init, database reset and re-seed. Splitting it by
lifecycle rather than by wish produced a smaller, safer answer.

**Vault initialisation must stay automatic, and it was not complete.** A freshly initialised
Vault has no `secret/` mount, no `transit/`, no `approle/` and no policies — so §5 of the
runbook was ten hand-typed `vault` commands, and until they ran, `SECRETS_PROVIDER=vault` put
field encryption in required mode with no key to use: **every write to any of the 20 encrypted
repositories raises.** That work is machine work with no decisions in it, it needs the root
token, and the only actor legitimately holding the root token is the bootstrap sidecar in the
seconds after `sys/init`. It now lives there (`provision_surface()`), creating: kv-v2 at
`secret/`, `transit/` + `hope-globalsetting` + `hope-phi`, `approle/`, the `hope-app` policy
(from new ConfigMap `hope-vault-policies`), the `hope-app` role, and Secret
`hope-vault-approle` carrying the gateway's credentials.

It is idempotent (checks before every create), self-healing (Secret `hope-vault-approle` is
both the output and the "already provisioned" marker), and it **ends in a canary rather than an
assumption** — it logs in with the credentials it just minted and encrypts under
`transit/hope-phi`. A failed canary writes no marker, so the next pass retries.

Runbook §5 is now "watch the log"; §7 collapsed from a port-forward plus four `vault` commands
to one `kubectl patch`.

**Deliberately NOT moved into the sidecar:** reading `hope-secrets`. The Role is narrowed
specifically to keep the Vault pod away from the database URL and MinIO credentials, so the
AppRole is published to its own Secret and the operator copies it across.

### 10b.3 `hope-reset` — the deliberate switch

`deployment/k8s/out-of-band/hope-reset.yaml`. One Job: validate the seed mode → prove Vault can
encrypt PHI under `hope-api`'s own AppRole → drop schema `core` and the Prisma ledger → `exec`
the same `migrate.sh` the ordinary `hope-db-migrate` Job runs.

**Why it cannot fire by accident.** `out-of-band/` is in no kustomization, so Argo never
renders, syncs or prunes it — safety is a property of where the file lives, not of a flag
someone must remember to unset. Beyond that the committed file is inert twice over: `image:` is
the literal `DATABASE_IMAGE` (unresolvable, so no pod starts) and `RESET_CONFIRM` is
`REPLACE-ME`, while step 0 accepts only `RESET <the namespace the pod is running in>`, built
from the downward API — so a confirmation typed for dev cannot run in staging or prod. Both
dangerous values are supplied at invocation and neither is stored. `backoffLimit: 0`.

An in-`base/` Job gated on a ConfigMap was rejected: the gate would live in Git, and a leftover
"approved" ConfigMap means the *next ordinary sync* wipes the database. An Argo PreSync hook was
rejected because a failing wave-hook wedges the whole Application — the failure that blocked
every Git change to this cluster for days in 2026-08.

**Why it fails closed.** Nothing is destroyed until two checks pass. (1) The Job asks the real
rule (`seed-mode.ts`, invoked from the image's own `dist/`) whether this `RUN_SEED` is permitted
under this `NODE_ENV` — so `RUN_SEED=all` in staging/prod refuses instead of leaving an empty
database. (2) It logs in with the AppRole from `hope-secrets` and encrypts under
`transit/hope-phi`. That makes the worst ordering — **database wiped, Vault broken** —
structurally impossible, and it catches the post-rebuild state where Vault is healthy but
`hope-secrets` still holds the previous Vault's credentials. `VAULT_ROLE_ID`/`VAULT_SECRET_ID`
are **required** here (they are `optional` on `hope-db-migrate`), so a missing AppRole stops the
pod starting rather than seeding `AiProviderConnection` rows with no key material.

**Recovery from any partial failure is the same command.** Steps 3–4 are re-runnable: the drops
are `IF EXISTS` and a re-run re-drops, so a failed seed is recovered from the same clean state
rather than by driving a half-seeded database forward (not all 25 phases are create-only).

**`prisma migrate reset` is deliberately not used.** Measured against prisma 7.9.1: it carries
an AI-agent guard that refuses based on ambient environment variables — a recovery path must not
depend on a heuristic *not* firing — and Prisma 7 dropped `--skip-seed`/`--skip-generate`, so it
would run a second, differently-gated seed of its own. Explicit SQL is used instead:
`DROP SCHEMA IF EXISTS "core" CASCADE` plus `DROP TABLE IF EXISTS public."_prisma_migrations"`.
**`public` is not dropped** — it owns the `vector`, `timescaledb` and `timescaledb_toolkit`
extensions, and only `vector` is recreated by the migrations.

**What it deliberately does not do:** initialise or wipe Vault (init is automatic and must stay
so; wiping the PVC scales a StatefulSet and deletes Secrets, and is a once-ever act on an
already-lost store — runbook §3), and re-seed the 23 platform KV secrets (their values exist
nowhere in the cluster; `vault-seed-secrets.sh` reads them from the operator's `.env.dev`).

### 10b.4 Verification — measured, not asserted

Against the real `hashicorp/vault:1.18.3` driven by `alpine/kubectl:1.34.1`'s busybox `wget`,
and against a throwaway PostgreSQL 18 (`timescale/timescaledb-ha:pg18-all`):

| Check | Result |
|---|---|
| `GET /ui/` on vault:1.18.3 with `ui = true` | `200`; `GET /` → `307 /ui/` |
| Rendered sidecar script, fresh Vault | init → 2 Secrets → unseal → 2 mounts + 2 transit keys + approle + policy + role → **canary OK** → `hope-vault-approle` written. No human step. |
| Sidecar restart, healthy Vault | logs only `started` — no re-init, no re-provision |
| `provision_surface()` re-run | creates nothing; canary passes again |
| `hope-app.hcl` through the busybox JSON escape | round-trips byte-identical (read back from `sys/policies/acl/hope-app`) |
| ConfigMap copy vs monorepo source | `diff` clean |
| `DROP SCHEMA core CASCADE` + ledger drop | `core` 108 → 0 tables; `vector` + `timescaledb` intact |
| `migrate deploy` after the drop | `core` 0 → 107 tables, 21 ledger rows, canary leftover gone |
| `resolveSeedMode()` preflight | `all`+development → `all`; `all`+production → **throws**; `bogus` → **throws** |
| `sh -n` on both rendered scripts (busybox) | OK |
| `kubectl kustomize` dev / staging / prod | all build, 107 objects each |
| `gitleaks dir` (monorepo `.gitleaks.toml`) | no leaks found, both repos |

## 11. Change History

| Date | Change |
|---|---|
| 2026-08-30 | **Owner asks: usable Vault UI + a deliberate reset signal (§10b).** Found `ui = true` was already committed and serving (verified 200 on `/ui/` against vault:1.18.3) — the gap was access, and the recommendation is `port-forward` to the POD, not a tunnel route, on TASK-828 §0/§2/§4 grounds (Access covers 1 app in the estate; `hope-vault` is headless with no NodePort, so a route would ADD exposure). Found "initialise Vault" was incomplete: a fresh Vault has no mounts, transit keys, approle or policy, so field encryption fails closed on first write — moved all of it into `provision_surface()` in the `vault-bootstrap` sidecar, ending in an AppRole transit canary, with the AppRole published to new Secret `hope-vault-approle` (runbook §5 becomes "watch the log", §7 becomes one `kubectl patch`). Added `deployment/k8s/out-of-band/hope-reset.yaml` — one Job, inert as committed, gated on `RESET <namespace>`, fail-closed behind a seed-mode preflight and the Vault canary so "DB wiped, Vault broken" cannot occur. Rejected `prisma migrate reset` (7.9.1 AI-agent guard + dropped flags). **Argo CD still cannot deliver anything** — the repo-server has been unreachable since 2026-08-29T16:43:29Z, so none of this is on the cluster. |
| 2026-08-30 | Opened from the TASK-808 §9 diagnosis, on the owner's directive. |
| 2026-08-30 | Seal decision made (Shamir + in-cluster `vault-bootstrap` sidecar); manifests committed as `28aa2a8` in `hope-v2-deployment` (unpushed); runbook added. Found and fixed a duplicate-`-config` entrypoint bug that would have shipped a Vault unable to start. Found that `10.10.1.134` also seals the Vault HA Raft cluster, down from the same event. Corrected the ticket's "Raft data" premise: the backend is `storage "file"`. |
| 2026-08-30 | **Review pass → `9425643` + `ccb35a4`.** Reproduced a data-loss bug in the sidecar (a failed Secret write after `sys/init` discarded the shares and left the store permanently unrecoverable) plus a 67s→2s cold-start regression and a missing pre-flight; all three fixed and re-verified. Added resources to both containers. **Found that the runbook's re-init path could not have worked**: a fresh non-dev Vault has no `secret/`, `transit/`, `approle/` or policies, and `vault-seed-secrets.sh` creates none of them — runbook §5 added. **Found that the wipe destroys the `hope-phi`/`hope-globalsetting` transit keys**, which encrypt columns across 20 repositories, and that their only backup lives on the VMs approved for destruction — snapshot gate added. Owner confirmed Path F (re-initialise) as the only path; runbook rewritten around the wipe, with an explicit verified-empty check. Annotated the three monitoring configs that would otherwise alert forever, and marked `infrastructure/single-deployment/vault/` retired. | Finally, found that `28aa2a8` was already pushed and that **Argo CD cannot sync `hope-v2-dev` at all** — repo-server down, and a `hope-db-migrate` `Replace=true` defect that has failed every sync since 2026-08-25. The manifests are proven but undeliverable until that is repaired; status moved to `Blocked` and the runbook now gates the wipe on it. |
