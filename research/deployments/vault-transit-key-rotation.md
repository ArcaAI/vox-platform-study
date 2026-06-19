# Vault Transit Key Rotation & Rewrap — `hope-phi`

**Ticket**: TASK-369 (Data Encryption Initiative — Phase 5, key management / OPS)
**Audience**: SRE / Vault operators
**Keys in scope**: `hope-phi` (PHI field-level encryption — primary), `hope-globalsetting` (envelope-encrypted settings — sibling, same procedure).

> This document is the **operator policy + procedure**. The application-side
> driver that walks stored ciphertext and calls `transit/rewrap` is owned by the
> CryptoService worker; here we define the Vault-side commands, the rotation
> cadence, and the safe ordering so a rotation never strands PHI ciphertext.

---

## 1. Transit key versioning model (read this first)

A Transit key is **versioned**. Encryption always uses the **latest** version;
decryption works for any version `>= min_decryption_version`. Three knobs:

| Setting | Meaning | Effect of raising it |
|---|---|---|
| `latest_version` | Newest key version (set by `rotate`) | New ciphertext uses it (`vault:vN:...`) |
| `min_decryption_version` | Oldest version Vault will still decrypt | **Retires** old versions — old ciphertext becomes **undecryptable** |
| `min_encryption_version` | Oldest version allowed to encrypt | Forces clients onto a newer version |

Ciphertext carries its version as a prefix: `vault:v3:base64...`. **Rotation is
cheap and safe** (old ciphertext keeps decrypting). **Raising
`min_decryption_version` is destructive** unless every stored ciphertext has
first been *rewrapped* up to a version that survives the cut.

```bash
# Inspect the current key state
vault read transit/keys/hope-phi
# -> latest_version, min_decryption_version, min_encryption_version, keys{...}
```

---

## 2. Routine rotation (scheduled, non-disruptive)

Rotating mints a new version; nothing must be rewrapped for reads to keep
working. Do this on the cadence in §5.

```bash
# 1. Rotate — latest_version increments (e.g. v3 -> v4)
vault write -f transit/keys/hope-phi/rotate

# 2. Confirm
vault read -field=latest_version transit/keys/hope-phi   # -> 4

# New PHI writes now emit vault:v4:...; existing vault:v1..v3 still decrypt
# because min_decryption_version is unchanged.
```

`min_decryption_version=1` was set at key init so historical ciphertext keeps
decrypting (mirrors the `hope-globalsetting` setup verified by the app
integration test "historical ciphertexts decrypt after transit key rotation").

---

## 3. Rewrap (re-encrypt existing ciphertext to the newest version)

`transit/rewrap` takes old ciphertext and returns ciphertext under the latest
key version **without ever exposing plaintext** (Vault decrypts + re-encrypts
internally). Vault does **not** know where your ciphertext lives — rewrap is
per-blob, so the app/data layer must iterate every stored ciphertext column and
write the new value back.

```bash
# Single value
vault write transit/rewrap/hope-phi ciphertext="vault:v1:OldBase64=="
# -> ciphertext: vault:v4:NewBase64==

# Batch (preferred — one round-trip per N rows)
vault write transit/rewrap/hope-phi batch_input='[
  {"ciphertext":"vault:v1:AAA=="},
  {"ciphertext":"vault:v2:BBB=="}
]'
# -> batch_results[].ciphertext (same order)
```

**Data-layer driver (owned by the CryptoService worker — shape only):**
1. Select a page of rows with `enc_* LIKE 'vault:v%'` below the target version.
2. Call `transit/rewrap/hope-phi` with the batch.
3. Write the returned ciphertext back in a transaction (idempotent; re-runnable).
4. Repeat until no rows remain below the target version.

> Rewrap is read-then-write on PHI tables — run it as a controlled background
> migration, never a destructive bulk `UPDATE`. It is safe to interrupt/resume.

---

## 4. Retiring an old key version (only after a full rewrap)

Raise the floor **only once** §3 reports zero ciphertext below the target.

```bash
# After every stored ciphertext is >= v4:
vault write transit/keys/hope-phi/config min_decryption_version=4 min_encryption_version=4
# Verify nothing in the DB still matches 'vault:v1:'..'vault:v3:' BEFORE this.
```

If you raise `min_decryption_version` past a version that still has live
ciphertext, that PHI becomes **permanently undecryptable**. There is no undo.

---

## 5. Rotation policy / cadence

| Trigger | Action | Rewrap? | Raise min_decryption_version? |
|---|---|---|---|
| Scheduled (every **90 days**) | `rotate` | Optional/lazy | No (keep history readable) |
| Annual hygiene | `rotate` + background rewrap | Yes | Yes, after rewrap completes |
| **Suspected key/Vault compromise** | Emergency — see §6 | Yes (all) | Yes (cut off old versions) |
| Operator offboarding (held a Shamir share) | Re-key Shamir (not Transit) — DR runbook §4 | n/a | n/a |

- `hope-phi` MUST be created non-exportable (`exportable=false`,
  `allow_plaintext_backup=false`) so the raw key can never leave the barrier.
  Verify: `vault read transit/keys/hope-phi` shows `exportable=false`.
- Auto-rotation (hands-off): `vault write transit/keys/hope-phi/config auto_rotate_period=2160h` (90d).

---

## 6. Emergency rotation (key compromise)

1. **Rotate now**: `vault write -f transit/keys/hope-phi/rotate`.
2. Force new writes onto the new version: `min_encryption_version=<new>`.
3. **Rewrap everything** (§3) — drive the data-layer migration to completion.
4. Once rewrap is verified complete, **retire** the compromised versions:
   `min_decryption_version=<new>` (§4).
5. Rotate the **AppRole secret-id** the app uses to reach transit (deploy-vm430-432-vault.md §11) and audit `vault audit` logs for unexpected `transit/decrypt` calls.
6. File an incident; reference the DR/break-glass runbook.

---

## 7. Required ACL policy (operator capability)

The rotation operator needs an entity/policy with:

```hcl
# vault policy write hope-transit-rotate -
path "transit/keys/hope-phi/rotate"   { capabilities = ["update"] }
path "transit/keys/hope-phi/config"   { capabilities = ["update"] }
path "transit/keys/hope-phi"          { capabilities = ["read"]   }
path "transit/rewrap/hope-phi"        { capabilities = ["update"] }
```

The runtime app role (`hope-app`) should hold only `transit/encrypt/hope-phi`
and `transit/decrypt/hope-phi` (+ `rewrap` if it runs the migration) — **not**
`rotate`/`config`. Keep rotation a separate, audited human capability.

---

## 8. Monitoring

Rotation/rewrap health rides on the Vault alerts in
[`../configs/postgres-ha/prometheus/vault-transit-alerts.yml`](../configs/postgres-ha/prometheus/vault-transit-alerts.yml):
`VaultSealed`/`VaultNoActiveNode` (page) gate all transit ops, and
`VaultRequestLatencyHigh` catches a rewrap migration overloading the crypto
path. After raising `min_decryption_version`, watch the app's PHI read path for
decrypt errors (the commented `HopePhiTransitCryptoFailing` alert) — any error
means a ciphertext below the new floor was missed.
