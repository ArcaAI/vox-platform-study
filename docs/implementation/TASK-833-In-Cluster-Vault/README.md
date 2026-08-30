# TASK-833 — Move the Vault seal in-cluster and retire the VM seal node

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `infrastructure` |
| **Severity** | **Dev is DOWN** — this is the fix for the TASK-808 §9 outage |
| **Repos** | `arca/hope-v2` (this ticket) · **`arca/hope-v2-deployment`** (the manifests) |
| **Owner directive** | 2026-08-30: *"we need in-cluster vault, lets ignore the vault deployed using vm cluster and switch to use the in-cluster vault"* |

## 1. Why

`hope-vault-0` in `hope-v2-dev` auto-unseals with a **transit seal against an external VM**,
`https://10.10.1.134:8200` (`deployment/k8s/base/vault.yaml:43-50`). That VM's Vault is **sealed**,
so:

```
error parsing Seal configuration … PUT https://10.10.1.134:8200/v1/transit/encrypt/hope-vault-k3s
→ Code: 503 … * Vault is sealed
```

`hope-vault-0` → `CrashLoopBackOff` (restartCount **507**, unready since **2026-08-28T11:52:20Z**) →
Service has no endpoint → DNS fails → `hope-api` fail-closes → **`0/2` for two days**.
Full chain in [TASK-808 §9](../TASK-808-Provider-Overrides/README.md).

**TASK-804 adopted the transit seal so that *"unsealing needs no keys and no human"*.** That is true
of `hope-vault-0` and false of the seal Vault it depends on — the single point of failure **moved
rather than disappeared**, and it is off-cluster, so nothing in Argo, the pipeline or the repo can
recover it.

## 2. The design decision this ticket must make

Removing the external seal raises the question TASK-804 answered badly: **what unseals the
in-cluster Vault after a restart?** The candidates, none free:

| Option | Unseals without a human? | Cost |
|---|---|---|
| **Shamir + an in-cluster unseal Job/sidecar** reading keys from a k8s `Secret` | yes | **unseal keys live in etcd** |
| **A second in-cluster Vault as transit seal** | yes, for the first | moves the problem — who unseals the sealer? |
| **Shamir, manual unseal** | **no** | exactly the outage TASK-804 fled: shares lost ⇒ unrecoverable |

**The lane must choose, justify, and state the residual risk plainly.** A dev namespace may
legitimately accept keys in etcd; that is a decision to record, not to hide.

### ⚠️ It compounds with TASK-828
[TASK-828](../TASK-828-Edge-Security-Findings/README.md) records that **Argo CD is exposed to the
internet with no SSO — local `admin` only — holding full write to `hope-v2-dev`.** Any unseal
material in an etcd `Secret` is therefore reachable by whoever reaches Argo. That does not veto the
Shamir-in-Secret option, but it does mean **828 stops being a separate concern** and should be
sequenced alongside.

## 3. Scope
- Manifests in **`arca/hope-v2-deployment`** (`deployment/k8s/base/vault.yaml` + overlays). Argo
  auto-syncs `main`; `prune` and `selfHeal` are currently **off**.
- **Do not destroy the VM.** The owner retires `10.10.1.134` and configures the Cloudflare tunnel
  hostname once the in-cluster Vault is verified healthy.
- No secret values in Git — the existing file keeps the token out via a `__SEAL_TOKEN__` placeholder
  rendered at container start; preserve that discipline whatever the new mechanism.

## 4. Definition of Done
- [ ] `hope-vault-0` Ready `1/1` with **no external dependency**
- [ ] It survives a deliberate pod delete and comes back Ready with no human action
- [ ] `hope-api` reaches `2/2` Ready
- [ ] No unseal material committed to Git; gitleaks clean
- [ ] Seal mechanism and residual risk documented at the manifest
- [ ] Owner notified with what to point the Cloudflare tunnel at, and confirmation the VM is safe to destroy

## 5. Change History
| Date | Change |
|---|---|
| 2026-08-30 | Opened from the TASK-808 §9 diagnosis, on the owner's directive. |
