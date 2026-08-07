# HOPE Vault (VM cluster) — Seal, Unseal & Auto-Unseal Runbook

> **This page covers the Vault that is actually running**: 3-node Raft on Proxmox VMs
> 430-432 with a Transit seal-Vault on VM 434, all in Docker on Alpine.
>
> ⚠️ **Do not use [`README.md`](./README.md) for this cluster.** That runbook targets the
> k3s/Helm Vault (`kubectl exec`, pods `vault-0..2`, ns `vault-system`) — a design that was
> built and never deployed. Its commands will not work here.

**If Proxmox just restarted and everything is down, go straight to [§4 S1](#s1--the-whole-proxmox-host-restarted).**
Every timing on this page was measured during a real full-stack restart drill on 2026-08-07
([evidence](#9-measured-evidence)), not estimated.

---

## 1. The one thing to understand

Auto-unseal is not magic and it is not symmetric. The dependency runs one way:

```
vault-seal (VM 434)  ──unseals──>  vault-1 / vault-2 / vault-3  (VMs 430/431/432)
   Shamir-sealed                          Transit-sealed
   NEVER auto-unseals                     ALWAYS auto-unseals
   needs 3 of 5 human-held shares         needs nothing but a reachable seal-Vault
```

So there is exactly **one manual step in any recovery: unseal VM 434.** Everything downstream
then heals itself. If you remember nothing else, remember that.

**The Raft nodes are only sealed at *startup*.** A running Raft node does not talk to the
seal-Vault at all — you can stop VM 434 entirely and the cluster keeps serving. The dependency
only bites when a Raft node *restarts* while 434 is sealed or unreachable.

### How the Raft nodes "retry" — this surprises people

A Raft node that starts while the seal-Vault is sealed **does not wait and retry internally**.
Vault fails during seal configuration and the process *exits*:

```
error parsing Seal configuration: Error making API request.
URL: PUT https://10.10.1.134:8200/v1/transit/encrypt/autounseal
Code: 503. Errors:
* Vault is sealed
```

The container then dies and Docker's `--restart unless-stopped` starts it again. **That
crash-loop is the retry mechanism.** It is not a fault — it is the system correctly waiting for
its dependency, and it is why recovery needs no intervention beyond unsealing 434.

Practical consequence: `docker ps` showing `Up 6 seconds` over and over on a Raft node is the
*expected* appearance of "waiting for the seal-Vault", not a broken container. Read the logs
before you touch anything.

---

## 2. Getting a shell

Root SSH is deliberately disabled on all four VMs (`/etc/ssh/sshd_config.d/hardened.conf`).
Reach them through the hypervisor.

```bash
# From the operator Mac → Proxmox host (needs `sudo cloudflared access rdp --hostname
# remote.taphuynh.dev --url ssh://localhost:22` running; see docs/operations/proxmox-mcp/)
ssh -i ~/.proxmox-mcp/ssh/proxmox_mcp_tunnel -p 22 root@localhost
```

From `pve-node1`, run commands inside a VM with the guest agent:

```bash
qm guest exec <VMID> --timeout 60 -- /bin/sh -c '<command>'
```

Or use the Proxmox web console (`Console` on the VM) for an interactive shell.

| VM | Host | Container name |
|---|---|---|
| 434 | `vault-seal` | `vault-seal` |
| 430 / 431 / 432 | `vault-1` / `vault-2` / `vault-3` | `vault` |

Every `vault` CLI call runs *inside* the container:

```bash
docker exec -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/ca.crt \
  <container> vault status
```

Set `alias v='docker exec -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/ca.crt vault vault'`
on a Raft node to save typing (`vault-seal` on VM 434).

---

## 3. Health check — run this first, always

```bash
# From pve-node1: full-cluster seal state in one shot
for i in 430 431 432 434; do
  printf '%s: ' "$i"
  qm guest exec $i --timeout 30 -- /bin/sh -c \
    'C=vault; [ "$(hostname)" = vault-seal ] && C=vault-seal
     printf "%s " $(hostname)
     docker exec -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/ca.crt \
       $C vault status 2>&1 | grep -E "^(Sealed|HA Mode)" | tr -s " "' \
    2>&1 | sed -n 's/.*out-data" : "\(.*\)".*/\1/p'
done
```

**Healthy looks like:** `vault-seal Sealed false`, and the three Raft nodes `Sealed false` with
exactly one `HA Mode active` and two `standby`.

Raft membership (needs a token — see [§7](#7-key-material)):

```bash
v operator raft list-peers      # expect 3 nodes, all Voter=true, exactly one leader
```

Leadership moves on restart — `vault-2` being leader instead of `vault-1` is normal, not a fault.

---

## 4. Scenario playbooks

### S1 — The whole Proxmox host restarted

**This is the common case and the one people panic about.** Expected state on the way back up:
all four VMs `running` (they carry `onboot: 1`), **`vault-seal` sealed**, all three Raft nodes
crash-looping. Nothing is broken. There is one thing to do.

```bash
# 1. Confirm the picture (§3). Expect: vault-seal Sealed true, Raft nodes crash-looping.

# 2. Unseal the seal-Vault — 3 of the 5 Shamir shares, entered one at a time.
#    Run on VM 434. Each command prompts for one key; "Unseal Progress" climbs 1/3 → 2/3 → 3/3.
docker exec -it -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/ca.crt \
  vault-seal vault operator unseal        # ×3, one share per invocation, different custodians

# 3. Confirm it opened.
docker exec -e VAULT_ADDR=https://127.0.0.1:8200 -e VAULT_CACERT=/vault/tls/ca.crt \
  vault-seal vault status | grep Sealed   # → Sealed  false

# 4. Do nothing else. Wait ~20s and re-run the §3 health check.
```

**Measured: all three Raft nodes returned unsealed 17 seconds after step 3, with no
intervention.** Docker's restart backoff is the only variable; allow up to ~60 s before
investigating.

If a node is still sealed after ~2 minutes, go to [S4](#s4--a-raft-node-is-crash-looping).

> **Ordering rule:** unseal 434 *first*. Restarting Raft nodes before the seal-Vault is open
> just burns restart backoff. There is never a reason to touch 430/431/432 in this scenario.

### S2 — Only the seal-Vault (VM 434) restarted

The Raft cluster is **unaffected and still serving** — running nodes never call the seal-Vault.

Unseal 434 as in S1 step 2. That's the whole procedure. But treat it as urgent anyway: until it
is unsealed the cluster has **no restart tolerance** — any Raft node that restarts in that window
will crash-loop until you fix it.

### S3 — A single Raft node restarted (seal-Vault healthy)

Nothing to do. The node auto-unseals and rejoins as a voter. Measured at **~20 s** from a hard
`qm reset`. Verify with `v operator raft list-peers`.

### S4 — A Raft node is crash-looping

```bash
docker logs vault 2>&1 | tail -20     # on the affected VM
```

| Log says | Meaning | Fix |
|---|---|---|
| `Code: 503 ... Vault is sealed` | seal-Vault is sealed | Unseal 434 ([S1](#s1--the-whole-proxmox-host-restarted) step 2). Node self-heals in ~20 s |
| `connection refused` / `i/o timeout` to `10.10.1.134:8200` | seal-Vault down or unreachable | Check VM 434 is running and its container is up; check `10.10.1.134` pings from the node |
| `x509: certificate signed by unknown authority` | `/vault/tls/ca.crt` missing or wrong on this node | Re-push the CA from `pve-node1:/root/vault-pki/ca.crt` |
| `permission denied` on `transit/decrypt/autounseal` | auto-unseal token revoked or expired | Mint a new one — [§6](#6-rotating-the-auto-unseal-token) |
| `error parsing Seal configuration` with no HTTP error | malformed `vault.hcl` | Inspect `/opt/vault/config/vault.hcl` (it is `0600 vault:vault`) |

Only after the dependency is fixed should you force a restart: `docker restart vault`.

### S5 — Quorum lost (2 of 3 Raft nodes gone)

The cluster stops serving writes. Bring the failed VMs back (`qm start`); with the seal-Vault
unsealed they auto-unseal and rejoin. If a node's disk is gone, remove it from the peer set and
re-add it — do **not** hand-edit Raft state:

```bash
v operator raft remove-peer vault-3
# then rebuild VM 432 and let retry_join re-add it
```

### S6 — 🔴 The seal-Vault is destroyed (disk loss on VM 434)

**This is the one that ends the cluster.** Without the Transit key, no Raft node can ever unseal
again — the Shamir shares unseal *434*, they do not unseal the Raft nodes.

Recovery path: rebuild 434, restore its data directory from backup, and the Transit key returns.
**There is currently no backup of VM 434** (see [§8](#8-known-gaps)). Until there is, treat VM
434's disk as the single point of failure for the entire secrets platform.

The recovery keys in `vault-raft-init.json` do **not** substitute — recovery keys authorize
`generate-root` and rekey operations against an *already-unsealed* Vault. They cannot unseal a
Transit-sealed node.

---

## 5. Manual unseal — reference

Vault's `operator unseal` takes one share per invocation and accumulates progress in memory. It
is designed so no single person holds enough shares:

```bash
vault operator unseal            # prompts; does not echo. Preferred.
vault operator unseal <share>    # avoid — the share lands in shell history
vault operator unseal -reset     # start over if someone pastes a wrong share
vault status | grep -E 'Sealed|Unseal Progress'
```

Progress resets if the process restarts. Shares are **5 total, threshold 3**, base64 form.

To deliberately seal a node (e.g. before maintenance): `vault operator seal`. On a Raft node
this is pointless — it will auto-unseal on the next restart.

---

## 6. Rotating the auto-unseal token

The Transit token is periodic (768 h) and self-renews while a Raft node is running. It only
expires if every node is down longer than the period. To mint a replacement:

```bash
# On VM 434, with the seal-Vault root token:
vault token create -policy=autounseal -period=768h -orphan -display-name=raft-autounseal
```

Then update `token = "..."` in `/opt/vault/config/vault.hcl` on **each** Raft node and
`docker restart vault` one at a time, confirming each rejoins before moving to the next.

The policy grants `update` on `transit/encrypt/autounseal` and `transit/decrypt/autounseal` and
nothing else — it cannot read, rotate, or delete the key. Keep it that way.

---

## 7. Key material

| What | Where | Purpose |
|---|---|---|
| 5 Shamir shares + root token (seal-Vault) | `434:/root/vault-seal-init.json` | **Unseals VM 434.** The only keys a human ever types |
| Auto-unseal token | `434:/root/vault-transit-token.json` | Embedded in each Raft node's config |
| 5 recovery shares + root token (cluster) | `430:/root/vault-raft-init.json` | `generate-root`, rekey. **Cannot unseal** |
| CA private key | `pve-node1:/root/vault-pki/ca.key` | Issues node certs |

🔴 **All four are still on disk at `0600`.** They must be retrieved, the shares distributed among
separate custodians, and the on-disk copies deleted. Both root tokens should then be revoked
(`vault token revoke -self`). Until that happens, anyone with hypervisor root can unseal the
platform unaided — which defeats the point of Shamir.

---

## 8. Known gaps

| Gap | Consequence |
|---|---|
| **No backup of VM 434** | [S6](#s6----the-seal-vault-is-destroyed-disk-loss-on-vm-434) is unrecoverable. Highest-priority fix |
| No Raft snapshots | `vault operator raft snapshot save` works on this cluster; nothing schedules it |
| All 4 VMs on `pve-node1` | Raft gives VM-level HA, not hardware HA |
| Key material on disk | [§7](#7-key-material) |
| No alerting on seal state | A sealed seal-Vault is silent until the next Raft restart fails |

That last one deserves emphasis: after [S2](#s2--only-the-seal-vault-vm-434-restarted) the
cluster looks perfectly healthy while having zero restart tolerance. A `vault_sealed` alert on
VM 434 is worth more than most of the dashboards.

---

## 9. Measured evidence

Full-stack restart drill, 2026-08-07, on the cluster with no production data:

| Step | Observed |
|---|---|
| `qm stop` ×4 → `qm start` ×4 | All VMs `running` via `onboot: 1` |
| seal-Vault after boot | `Initialized true`, `Sealed true`, `Unseal Progress 0/3` |
| Raft nodes while 434 sealed | Crash-looping; `Code: 503 * Vault is sealed` |
| After 3 shares entered on 434 | `Sealed false` |
| **Raft nodes, no intervention** | **3/3 unsealed at t+17 s** |
| Cluster after recovery | 3 voters, one leader (`vault-2` — leadership moved, expected) |
| Single node hard `qm reset` (earlier) | Unsealed + rejoined as voter in ~20 s |

---

## Related

- [Vault HA deployment record](../../implementation/TASK-616-Deployment-CICD-Observability-Modernization/vault-ha-deployment-2026-08.md) — what was built, deviations, remaining work
- [Design rationale §C1](../../implementation/TASK-616-Deployment-CICD-Observability-Modernization/component-designs.md) — why Transit auto-unseal replaced the runbook's manual Shamir
- [Proxmox MCP setup](../proxmox-mcp/README.md) — the `cloudflared` hop this page's SSH depends on
- [`README.md`](./README.md) — the **k3s** Vault runbook. Different deployment; not this cluster
