# Track V — Vault HA deployment record (2026-08-07)

**Status**: Phase 1 complete — 3-node Raft cluster live with Transit auto-unseal, verified against a hard power cycle.
**Scope of this record**: what was actually built and proven, the deviations from [Appendix C §C1](./component-designs.md), and the operational caveats that follow from them.
**Not yet done**: Kubernetes auth, per-service policies, Agent injector, secret migration off the in-cluster Vault, snapshot automation. See §6.

---

## 1. What exists now

| VM | Name | IP | vCPU / RAM / disk | Role |
|---|---|---|---|---|
| 430 | `vault-1` | 10.10.1.130 | 1 / 2 GB / 38 GB | Raft **leader**, voter |
| 431 | `vault-2` | 10.10.1.131 | 1 / 2 GB / 38 GB | Raft follower, voter |
| 432 | `vault-3` | 10.10.1.132 | 1 / 2 GB / 38 GB | Raft follower, voter |
| 434 | `vault-seal` | 10.10.1.134 | 2 / 2 GB / 18 GB | Transit seal-Vault (file storage, Shamir) |

All four: Alpine 3.23 (cloned from template 903), Vault **1.21.2** in Docker with
`--restart unless-stopped` and `--cap-add=IPC_LOCK`, `onboot: 1`. This matches the estate's
existing service pattern (`redis-01` runs the same way).

Addressing follows the estate convention **VMID − 300 = final octet**, which is why the
design's stated `10.10.1.134` for VM 434 was already correct.

## 2. Verification evidence

```
# Raft membership (from vault-1)
Node       Address             State       Voter
vault-1    10.10.1.130:8201    leader      true
vault-3    10.10.1.132:8201    follower    true
vault-2    10.10.1.131:8201    follower    true

# vault-1
Seal Type transit · Initialized true · Sealed false · Storage Type raft · HA Mode active
# vault-2, vault-3
Sealed false · HA Mode standby
```

**Auto-unseal proven under a hard power cycle.** `qm reset 432` (a power cycle, not a
graceful shutdown) — `vault-3` returned **unsealed** and rejoined as a voter in ~20 s with no
human interaction:

```
core: stored unseal keys supported, attempting fetch
core: vault is unsealed
core: unsealed with stored key
```

This is the specific failure mode [§C1.4](./component-designs.md) rejected the VM runbook's
manual Shamir design over: a 5-of-3 Shamir cluster wedges on every restart until three humans
are simultaneously available. One on-call engineer can now restart any Raft node alone.

Audit devices (`file`) are enabled on the Raft cluster and on the seal-Vault. This matters
beyond hygiene: **Vault blocks all requests if its only audit device cannot write**, so the
device existing is a prerequisite for PHI traffic, not an optional extra.

## 3. Deviations from the design, and why

| Design said | Built | Why |
|---|---|---|
| Vault 1.21.2 | ✅ same | — |
| 3-node Raft on VMs 430-432 | ✅ same | — |
| Transit auto-unseal from dedicated VM 434 | ✅ same (Option A) | Appendix B's finding stands: the k3s datastore is SQLite with no snapshot backstop, so an in-cluster seal-Vault risks permanently sealing the estate |
| TLS everywhere | ✅ internal CA | The VM runbook left cert issuance as an unfilled `<SRE:>` placeholder. Built a private CA (`HOPE Internal Vault CA`, RSA-4096, 10 y) issuing 825-day server certs with correct SANs (`DNS:<name>, DNS:localhost, IP:<addr>, IP:127.0.0.1`). **CA private key lives only at `/root/vault-pki/ca.key` on `pve-node1`** |
| — | **swap disabled on all four VMs** | Not in the design; a real defect it would have shipped. HashiCorp recommends `disable_mlock = true` with Raft storage, but the Alpine template carries a 2 GB swap partition — that combination lets Vault page decrypted secrets to disk. `disable_mlock = true` is only safe with swap off, so swap was disabled and removed from `/etc/fstab` |

## 4. Deliberate posture choices

- **Root SSH stays disabled.** The template ships `/etc/ssh/sshd_config.d/hardened.conf` with
  `PermitRootLogin no`, which wins over the main config's `yes` (first-match). Rather than
  weaken it for convenience, all provisioning went through the hypervisor's QEMU guest agent.
  A Vault node with no network-reachable root login is the correct posture; the stray key added
  during debugging was removed.
- **The Transit token never entered a transcript or a log.** It is embedded in each node's
  `/opt/vault/config/vault.hcl` at `0600 vault:vault`, which is the documented pattern and
  matches the design's HCL snippet.
- **The token is least-privilege**: `update` on `transit/encrypt/autounseal` and
  `transit/decrypt/autounseal` only — it cannot read, rotate, or delete the key.

## 5. Operational caveats — read before relying on this

1. 🔴 **The seal-Vault does not auto-unseal.** It is Shamir-sealed by design (nothing on-prem
   can seal it without inventing a fourth Vault). **If VM 434 reboots, it comes back sealed, and
   any Raft node that restarts during that window cannot unseal.** Already-running Raft nodes are
   unaffected — they only need Transit at unseal time. Operationally: unseal 434 first, always;
   never reboot 434 and a Raft node in the same window.
2. 🔴 **Key material is on the VMs and must be moved offline.** Contents were deliberately never
   printed:
   - `434:/root/vault-seal-init.json` — 5 Shamir shares + root token for the seal-Vault
   - `434:/root/vault-transit-token.json` — the periodic auto-unseal token (768 h, renewing)
   - `430:/root/vault-raft-init.json` — 5 **recovery** shares + root token for the cluster
   - `pve-node1:/root/vault-pki/ca.key` — the CA private key
   All are `0600`. Retrieve, distribute the shares among operators, then delete from disk.
3. **Both root tokens are still live.** The design's own standard is that root should not exist as
   a standing credential. They are needed for §6's work; revoke immediately after.
4. **Single failure domain.** All four VMs are on `pve-node1`. Raft gives process/VM-level HA, not
   hardware HA — losing that host loses the quorum. Same caveat already recorded for the k3s node.
5. **No snapshots yet.** `vault operator raft snapshot` works on this cluster (unlike the
   `storage "file"` Vault it replaces), but nothing schedules it.

## 6. Remaining Track V work

| # | Item | Blocked on |
|---|---|---|
| V.1 | Retrieve key material offline; revoke both root tokens | **Owner** |
| V.2 | Kubernetes auth against the k3s cluster + the 7 per-service policies (`infrastructure/docker/configs/vault/policies/k8s/hope-*.hcl` — already written) | Nothing |
| V.3 | Migrate secrets off the in-cluster Vault. It uses `storage "file"`, so `raft snapshot` cannot be used — this must be a scripted read/write of every key (`vault kv list -recurse secret/`) | V.2 |
| V.4 | Vault Agent Injector for the 6 Python services; gateway keeps its own AppRole (it is already a full Vault client) | V.2 |
| V.5 | Raft snapshot CronJob → MinIO, 14-day retention, **plus a tested restore** | Nothing |
| V.6 | Distribute `ca.crt` to k3s workloads + the gateway | V.2 |
| V.7 | Retire the in-cluster Vault (`hope-v2-deployment/deployment/k8s/base/vault.yaml`) and its plaintext `hope-vault-init` Secret | V.3 |

## 7. Trap for anyone else cloning template 903

**Template 903 carries `redis-1`'s static IP `10.10.1.120` and hostname.** Every clone boots
holding the live `redis-01` address. Four clones did exactly that here; it was caught and
corrected within ~2 minutes and `redis-01` was verified unaffected (12-day uptime intact, no
restart), but a slower reaction would have disrupted a live service.

Either fix the template to boot with DHCP or no address, or treat "set hostname and IP before
the clone is left running" as a mandatory first step. The same applies to the SSH host keys,
which every clone inherits from the template — they were regenerated per node here.
