# TASK-833 — Move the Vault seal in-cluster and retire the VM seal node

| Field | Value |
|---|---|
| **Status** | `Review` — manifests committed (not pushed); **an operator step is required to end the outage** (§7) |
| **Type** | `infrastructure` |
| **Severity** | **Dev is DOWN** — this is the fix for the TASK-808 §9 outage |
| **Repos** | `arca/hope-v2` (this ticket) · **`arca/hope-v2-deployment`** (the manifests, commit `4fa3ab2` on `main`, **unpushed**) |
| **Owner directive** | 2026-08-30: *"we need in-cluster vault, lets ignore the vault deployed using vm cluster and switch to use the in-cluster vault"* |
| **Operator runbook** | `hope-v2-deployment/docs/vault-seal-migration.md` |

## 1. Why

`hope-vault-0` in `hope-v2-dev` auto-unsealed with a **transit seal against an external VM**,
`https://10.10.1.134:8200`. That VM's Vault is **sealed**, so:

```
error parsing Seal configuration … PUT https://10.10.1.134:8200/v1/transit/encrypt/hope-vault-k3s
→ Code: 503 … * Vault is sealed
```

`hope-vault-0` → `CrashLoopBackOff` (restartCount **517** as of 2026-08-30, unready since
**2026-08-28T11:52:20Z**) → Service has no endpoint → DNS fails → `hope-api` fail-closes
(`getaddrinfo ENOTFOUND hope-vault`) → **`0/2` for two days**.

**TASK-804 adopted the transit seal so that *"unsealing needs no keys and no human"*.** That is
true of `hope-vault-0` and false of the seal Vault it depends on — the single point of failure
**moved rather than disappeared**, and it is off-cluster, so nothing in Argo, the pipeline or the
repo can recover it.

### 1.1 Two corrections to the ticket as opened

**The storage backend is `storage "file"`, not Raft.** The brief asked whether "the existing Raft
data" can be kept. There is no Raft here and no `vault operator raft snapshot` — a backup is a
copy of the PVC directory. The seal question is unaffected (a file backend stores a
seal-wrapped root key exactly as Raft does), but the backup procedure is different and the
runbook says so.

**The outage is bigger than `hope-api`.** `10.10.1.134` holds **two** transit keys:
`hope-vault-k3s` (for `hope-vault-0`) and `autounseal` (for the 3-node Vault HA Raft cluster,
`vault-1/2/3` on `10.10.1.130/131/132`). Prometheus shows all three Raft nodes unreachable —
last successful scrape `2026-08-28 04:56:57Z`, first failed scrape `2026-08-28 11:56:57Z`,
bracketing `hope-vault-0`'s `11:52:20Z`. **One VM sealing took down the entire HOPE Vault estate
in the same window.** TASK-833 frees only `hope-vault-0`; see §8.

## 2. The decision

**Shamir seal, unsealed in-cluster by a `vault-bootstrap` sidecar.**

| Option | Verdict |
|---|---|
| **Shamir + in-cluster unseal** | **CHOSEN.** Everything needed to start Vault is inside the namespace. Cost: shares in an etcd Secret. |
| A second in-cluster Vault as transit seal | **REJECTED.** It renames the question rather than answering it — something must still unseal the sealer — and rebuilds the exact failure shape we are fixing (one Vault that cannot start until another Vault is up) *inside* one namespace, with a second storage backend and a boot-ordering dependency. Two failure domains, one of which still ends in "keys in a Secret". |
| Shamir, manual unseal | **REJECTED.** Every pod restart, node reboot and eviction becomes an outage that waits for a human, and the shares get lost — which is what happened before TASK-804 and what it was right to flee. It trades one two-day outage for an unbounded number of shorter ones. |

**Sidecar, not a Job** — and the retired `hope-vault-init` Job is deleted, because its shape could
not do this work and twice caused an incident of its own:

* a Job runs **once** (its own comment conceded it was "load-bearing exactly ONCE"), while
  unsealing is needed on **every** pod start;
* as an Argo `hook: Sync` at wave 1, a failure does not fail alone — it **wedges the whole
  Application**, which it did for days in August 2026 on a withdrawn base image;
* it waited on `http://hope-vault:8200`, a name the headless Service does not publish while the
  only pod is NotReady — and an uninitialised Vault answers 501 on the readiness probe, so it is
  never Ready before init. **It could never have bootstrapped a fresh namespace.** On `127.0.0.1`
  that deadlock cannot arise.

### 2.1 Residual risk — recorded at the manifest, not only here

The unseal shares live in Secret `hope-vault-unseal` in `hope-v2-dev`, so anyone who can read
Secrets in that namespace can unseal this Vault. Accepted **for a dev namespace**, on two grounds:

1. **It widens nothing.** Secret `hope-vault-init` in the same namespace *already* holds the
   initial **root token** (written automatically since TASK-804). Anyone who can read it can read
   every secret out of a running Vault directly. Against that, possession of the unseal shares is
   not a new capability — the root token is the larger exposure, and §6 recommends revoking it.
2. The alternative is not "no keys in etcd", it is "a human unseals it by hand", which is the
   rejected option above.

**Staging and production must not inherit this.** There the seal belongs on a KMS the cluster
authenticates to with a workload identity it cannot exfiltrate (AWS KMS via IRSA —
`hope-v2-deployment/docs/aws-eks/02-kms-and-secrets.md`), so no unseal material exists in etcd.

### 2.2 Interaction with TASK-828

TASK-828 §1 is **now CLOSED** — the owner is configuring Entra SSO for Argo CD directly — so the
brief's framing ("Argo CD is exposed with no SSO") describes a window that is being closed rather
than a standing state. Until it lands, `argo.taphuynh.dev` is internet-reachable behind one local
`admin` password, and an Argo admin can reach any Secret in `hope-v2-dev`. That password is
therefore also the control standing between the internet and these shares.

This seal choice **does not create that exposure and does not depend on it being fixed** — the
root token in `hope-vault-init` was already reachable the same way. But the two should be
sequenced together, and the Argo SSO work should land before or alongside this. Note that the dev
`AppProject` **blacklists `Secret` outright**, so Argo cannot sync unseal material from Git even
if someone tried — the material is out-of-band by construction, exactly like `hope-secrets`.

## 3. What was built

`hope-v2-deployment` commit `4fa3ab2` on `main` (**not pushed**):

| File | Change |
|---|---|
| `deployment/k8s/base/vault.yaml` | Transit seal removed → Shamir. New `vault-bootstrap` sidecar (init + perpetual unseal). `hope-vault-init` Job deleted. Role narrowed with `resourceNames`. `serviceAccountName: hope-vault-init` on the StatefulSet. |
| `deployment/secrets.dev.yaml.example` | Documents `hope-vault-unseal`; retires `hope-vault-seal`. |
| `docs/vault-seal-migration.md` | **New.** The operator runbook — both recovery paths, verification, VM-retirement gate. |

Three details that are load-bearing and easy to undo by accident:

* **`command: ["vault"]` is explicit on purpose.** `hashicorp/vault`'s entrypoint rewrites
  `server` to always prepend `-config="$VAULT_CONFIG_DIR"`, so passing an explicit
  `-config=<file>` through it loads the config **twice** and Vault dies on a duplicate listener
  (`bind: address already in use`). The previous revision escaped this only because its
  `/bin/sh -c` wrapper replaced the entrypoint too. Caught by the end-to-end test in §5 — it
  would have shipped as a new, self-inflicted outage.
* **Shares are mounted as FILES, not env.** A Secret injected as an env var is fixed for the
  container's lifetime, so a sidecar started before the Secret existed would never see it.
* **`optional: true` on that volume is not defensive habit.** Without it the pod cannot start
  until the Secret exists, and the Secret cannot exist until the sidecar initialises a Vault that
  cannot start — a fresh namespace would deadlock on first boot.

## 4. Existing state — what happens to each piece

| Object | Disposition |
|---|---|
| **PVC `hope-vault-data`** | **Kept, untouched.** It is the store. Initialised 2026-08-25 under the transit seal. |
| **Secret `hope-vault-seal`** (transit token + CA) | Becomes unreferenced. Argo never managed it (Secrets are blacklisted). Delete after the VM is retired; revoke the token first. |
| **Secret `hope-vault-init`** (recovery keys + root token) | **Kept — and it is the key to path M.** Its `recovery_keys_b64` are what `unseal -migrate` consumes. Afterwards: copy off-cluster, then **revoke the root token**. |
| **Secret `hope-vault-unseal`** | **New.** Not in Git. Written by the sidecar (fresh init) or by the operator (after migration). |
| **Job `hope-vault-init` + pod `…-5q6dn`** | Removed from Git. **`prune: false` means Argo will NOT delete the live objects** — they linger, Completed and inert, until deleted by hand. |
| **Pods `hope-vault-wipe`, `hope-vault-wipe-2`** | Untouched by this change (never in Git). `Completed` since 2026-08-25; delete as cleanup. |

### 4.1 Do the existing secrets survive? — **conditionally yes**

The store's root key is encrypted by the transit key on `10.10.1.134`. Recovery keys do **not**
unseal an auto-unsealed Vault, and a PVC backup is useless without that key. HashiCorp is
explicit: *"the seal migration operation requires both the old and new seals to be available"*,
and if the seal mechanism is permanently lost *"the Vault cluster cannot be recovered, even from
backups."*

So:

* **If `10.10.1.134` can be unsealed once → Path M → every secret survives.** Verified end to
  end (§5), including destroying the transit vault afterwards.
* **If it cannot → Path R → the store is unrecoverable**, and 23 platform secrets plus the
  gateway's AppRole must be re-created.

**The owner is very likely already going to unseal that VM**, because it is also the only way the
Raft cluster comes back (§1.1). If it is being unsealed anyway, **Path M costs nothing extra**,
and it should be the default plan.

## 5. Verification — actual output, not assertions

Tested against `hashicorp/vault:1.18.3` with the **verbatim** `vault.hcl` and sidecar script
extracted from the committed manifest.

**Parsing logic, in busybox (the shell `alpine/kubectl` actually runs) — 11/11:**
`uninit detected · inited not misdetected · sealed detected · unsealed not misdetected ·
keys_base64 present · share count · share 1 (base64, not raw) · share 3 · root token ·
short-share guard · unseal payload`. `sh -n` clean; `shellcheck -s sh` clean.

**Fresh bootstrap — no human action:**
```
[vault-bootstrap] uninitialised - performing Shamir init (5 shares, threshold 3)
[vault-bootstrap] unseal shares 1-3 stored in Secret hope-vault-unseal
[vault-bootstrap] full bundle + root token stored in Secret hope-vault-init
[vault-bootstrap] sealed - submitting shares
{"type":"shamir","initialized":true,"sealed":false,"t":3,"n":5,...}
```

**DoD "survives a deliberate pod delete" — both containers destroyed, PVC + Secret kept:**
```
UNSEALED after ~3s
[vault-bootstrap] started; seal is shamir, shares are read from /vault/unseal
[vault-bootstrap] sealed - submitting shares          ← note: NO re-init
readiness probe: HTTP/1.1 200 OK                      ← pod goes Ready, DNS returns, hope-api can boot
```

**The live failure reproduced verbatim** (transit vault sealed, same request path):
```
URL: PUT http://transitvault:8200/v1/transit/encrypt/hope-vault-k3s
Code: 503. Errors: * Vault is sealed
```

**This commit landing on the current transit-sealed store — fails safe:**
```
Error initializing core: cannot seal migrate from "transit" to Shamir, no disabled seal in configuration
files: 34    store checksum: 6920ad09a7b68da5239a2b3a9a8b2a70c7b2652c   ← unchanged
```

**Path M, end to end, with a canary secret:**
```
canary written under the transit seal:            CANARY-SURVIVED
migration config (transit disabled=true):         Seal Type shamir · Sealed true
unseal -migrate share 1:  Unseal Progress 1/3 · Seal Migration in Progress true
unseal -migrate share 2:  Unseal Progress 2/3 · Seal Migration in Progress true
unseal -migrate share 3:  Sealed false
>>> transit vault (10.10.1.134 equivalent) DESTROYED <<<
pure-Shamir config start errors: 0 · old recovery keys unseal it · Sealed false
★ CANARY, VM destroyed, in-cluster Shamir seal:   CANARY-SURVIVED
```

**Build + secret hygiene:**
```
kubectl kustomize deployment/k8s/overlays/dev  →  BUILD OK (106 resources)
grep -rn '10\.10\.1\.134' deployment/k8s/base/vault.yaml  →  historical comments only, no config
gitleaks 8.30.1 detect --no-git  →  leaks found: 1   (was 2 before this change)
```
The single remaining finding is **pre-existing and untouched**: `secrets.dev.yaml.example:52`,
the seeded dev `API_GATEWAY_KEY` fixture the file deliberately documents (removing it breaks the
documented dev provisioning path — that belongs to TASK-832 §7, not here). `git diff` touches it
zero times. The second finding, a false positive on a `vault token create -policy=…` comment, is
gone because that comment was removed.

## 6. What Argo will do when this is pushed

`main` auto-syncs; `prune: false`, `selfHeal: false`.

| Resource | Argo action | Effect |
|---|---|---|
| ConfigMap `hope-vault-config` | patched | seal stanza gone |
| StatefulSet `hope-vault` | patched (`spec.template` is mutable) | `hope-vault-0` recreated with 2 containers |
| Role `hope-vault-init` | patched | narrowed to `resourceNames` |
| ServiceAccount / RoleBinding / Service / PVC | unchanged | — |
| Job `hope-vault-init` | **not deleted** — `prune: false` | Completed Job + pod linger; remove by hand |
| Secrets (`hope-vault-seal`, `hope-secrets`, `hope-vault-unseal`) | **never touched** | the dev AppProject blacklists `Secret` |

Then `hope-vault-0` fails with `cannot seal migrate from "transit" to Shamir…` and stays in
CrashLoopBackOff. **That is expected.** It is strictly better than today's failure — local rather
than a network call to a VM that may never return, self-describing, and verified non-destructive.

**Pushing is safe and reversible. Only destroying the VM is irreversible.**

## 7. Handover — what the owner must do

Full procedure: `hope-v2-deployment/docs/vault-seal-migration.md`.

1. **Back up first**: Secrets `hope-vault-init`, `hope-vault-seal`, `hope-secrets`, plus a tar of
   the PVC (file backend — there is no raft snapshot).
2. **Decide**: can `10.10.1.134` be unsealed once? → **Path M** (secrets preserved) or **Path R**
   (re-init + re-seed 23 secrets + re-mint the `hope-app` AppRole and patch `hope-secrets`;
   note `API_KEY_PEPPER` changing invalidates every issued API key at once).
3. **Verify before retiring anything** — six checks in the runbook, the acceptance one being
   `kubectl delete pod hope-vault-0` → back Ready with no human action, then `hope-api` `2/2`.
4. **Cloudflare tunnel: point it at nothing.** `hope-vault` is a **headless** Service
   (`clusterIP: None`) with no NodePort, LoadBalancer or Ingress, and the tunnel reaches this
   cluster via NodePorts on `10.10.1.10`. Re-pointing would mean *adding* a new exposure, not
   redirecting an existing one — and per TASK-828 §4 most HOPE tunnel routes have no Access
   application, so it would put a PHI platform's secrets plane on the internet behind nothing.
   In-cluster consumers use `http://hope-vault:8200`; an operator uses
   `kubectl port-forward -n hope-v2-dev svc/hope-vault 8200:8200`, already behind Rancher's
   Azure AD. **Retire the route rather than re-pointing it.**
5. **Do not destroy the VM yet** — see §8.

## 8. ⚠️ Follow-up required before `10.10.1.134` is destroyed

TASK-833 frees `hope-vault-0` and **nothing else**. The VM also holds the `autounseal` transit key
for the 3-node Vault HA Raft cluster (`vault-1/2/3`, VMs 430–432), which per
`docs/operations/vault/vm-cluster-seal-unseal.md` is Shamir-sealed and *"never auto-unseals"* —
*"there is exactly one manual step in any recovery: unseal VM 434."*

All three Raft nodes are currently unreachable to Prometheus, from the same 2026-08-28 window.
**Destroying the VM after this ticket would permanently break that cluster's auto-unseal**, repeating
this incident at larger scale. Either migrate the Raft cluster off the VM too, or formally
decommission it. **That is a separate ticket and is not in TASK-833's scope.**

Two smaller follow-ups, deliberately not done here to keep the change surgical:
* `hope-vault-0` is **BestEffort** (`resources: {}`) — the secrets plane is first to be evicted
  under node memory pressure. It should carry requests/limits.
* `alert-rules.yaml`'s `VaultSealed` remediation text points at `10.10.1.134`. It targets the
  **Raft** cluster, not `hope-vault-0`, so it is correct today and must be updated as part of §8,
  not this ticket.

## 9. Definition of Done

- [x] Seal mechanism chosen, justified, alternatives rejected in writing (§2, and at the manifest)
- [x] Residual risk stated at the manifest, not only in the ticket (§2.1)
- [x] TASK-828 interaction stated explicitly (§2.2)
- [x] No unseal material in Git; gitleaks run and reported (§5)
- [x] Fate of every pre-existing object recorded (§4)
- [x] Whether existing secrets survive, answered with evidence (§4.1, §5)
- [x] Exact Argo behaviour stated (§6)
- [x] Owner handover: tunnel, verification, re-init path (§7, runbook)
- [ ] `hope-vault-0` Ready with no external dependency — **blocked on the §7 operator step**
- [ ] Survives a deliberate pod delete **in the cluster** (proven in a faithful harness, §5)
- [ ] `hope-api` reaches `2/2` — follows from the above
- [ ] VM confirmed safe to destroy — **blocked on §8 (Raft cluster)**

## 10. Change History

| Date | Change |
|---|---|
| 2026-08-30 | Opened from the TASK-808 §9 diagnosis, on the owner's directive. |
| 2026-08-30 | Seal decision made (Shamir + in-cluster `vault-bootstrap` sidecar); manifests committed as `4fa3ab2` in `hope-v2-deployment` (unpushed); runbook `docs/vault-seal-migration.md` added. Found and fixed a duplicate-`-config` entrypoint bug that would have shipped a Vault unable to start. Found that `10.10.1.134` also seals the Vault HA Raft cluster, which is down from the same event — §8 raised. Corrected the ticket's "Raft data" premise: the backend is `storage "file"`. |
