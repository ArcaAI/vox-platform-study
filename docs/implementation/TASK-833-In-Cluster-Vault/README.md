# TASK-833 — Move the Vault seal in-cluster and retire the VM Vault estate

| Field | Value |
|---|---|
| **Status** | `Review` — manifests committed (not pushed); **operator steps required to end the outage** (§7) |
| **Type** | `infrastructure` |
| **Severity** | **Dev is DOWN** — this is the fix for the TASK-808 §9 outage |
| **Repos** | `arca/hope-v2` (this ticket) · **`arca/hope-v2-deployment`** (the manifests: `28aa2a8` then `9f87939` on `main`, **unpushed**) |
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

### 3.2 `9f87939` — the review pass (§4)

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
- [ ] `hope-vault-0` Ready **in the cluster** with no external dependency — **blocked on §7**
- [ ] `hope-api` reaches `2/2` — follows from the above
- [ ] Transit keys re-created and the undecryptable rows triaged — **blocked on §7 step 7**
- [ ] VMs snapshotted, then destroyed, with the three monitoring edits in one commit — **blocked on §8**

## 11. Change History

| Date | Change |
|---|---|
| 2026-08-30 | Opened from the TASK-808 §9 diagnosis, on the owner's directive. |
| 2026-08-30 | Seal decision made (Shamir + in-cluster `vault-bootstrap` sidecar); manifests committed as `28aa2a8` in `hope-v2-deployment` (unpushed); runbook added. Found and fixed a duplicate-`-config` entrypoint bug that would have shipped a Vault unable to start. Found that `10.10.1.134` also seals the Vault HA Raft cluster, down from the same event. Corrected the ticket's "Raft data" premise: the backend is `storage "file"`. |
| 2026-08-30 | **Review pass → `9f87939`.** Reproduced a data-loss bug in the sidecar (a failed Secret write after `sys/init` discarded the shares and left the store permanently unrecoverable) plus a 67s→2s cold-start regression and a missing pre-flight; all three fixed and re-verified. Added resources to both containers. **Found that the runbook's re-init path could not have worked**: a fresh non-dev Vault has no `secret/`, `transit/`, `approle/` or policies, and `vault-seed-secrets.sh` creates none of them — runbook §5 added. **Found that the wipe destroys the `hope-phi`/`hope-globalsetting` transit keys**, which encrypt columns across 20 repositories, and that their only backup lives on the VMs approved for destruction — snapshot gate added. Owner confirmed Path F (re-initialise) as the only path; runbook rewritten around the wipe, with an explicit verified-empty check. Annotated the three monitoring configs that would otherwise alert forever, and marked `infrastructure/single-deployment/vault/` retired. |
