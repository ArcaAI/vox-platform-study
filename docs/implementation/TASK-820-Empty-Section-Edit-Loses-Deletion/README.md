# TASK-820 — An empty section edit silently loses the deletion

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` |
| **Severity** | **High — silent loss of clinical intent, no outage required** |
| **Found by** | TASK-819 lane, 2026-08-29, while fixing the adjacent swallow |
| **Depends on** | TASK-819 (merged) |

## 1. The defect

A clinician **emptying** a section loses the deletion. No Vault outage is involved — this happens
against a fully working encryptor.

`encryptStringToCiphertext` returns `null` for `''`, so `encryptContentIntoEntity` no-ops, and
`AutoEntityChangeMapper`'s `if (result) model[key] = result` guard skips the null. The **old
ciphertext stays** while `state`, `revision` and `_version` all advance. On reload the deleted text
reappears.

Proven by the TASK-819 lane against a working encryptor:

```
expect(r.applied).toBe(true)                         ✓ the empty edit COMMITS
expect(row.state).toBe(CONFIRMED)                    ✓
expect(row.revision).toBe(4)                         ✓ revision advanced
expect(row.encryptedContent?.equals(OLD)).toBe(true) ✓ ...but the OLD text is still stored
```

## 2. A test currently gives false assurance

`"accepts an EMPTY edit — a clinician deleting their own text owes the transcript no contradiction"`
passes **only because it mocks `encryptContentIntoEntity`**. It asserts the write was attempted,
never that the body was cleared. Any fix must replace that assertion with one that checks the
persisted ciphertext, or the same bug can return under a green suite.

## 3. The decision this needs

Whether an empty write should **null `encryptedContent`**. That touches the
`deletion-without-contradiction` neighbourhood, which exists to stop a MACHINE writer silently
emptying prose it wrote earlier — while a clinician emptying their own section is authorized by
definition (TASK-811 §8b). The fix must preserve that distinction rather than collapse it.

## 4. Related, unassessed
The `encryptBestEffort` family — `summary.service.ts`, `sttInternal.service.ts`,
`ocr-enrichment.processor.ts`, `chain-summary.service.ts` — wraps `ContextItem.encryptContentIntoEntity`
in the same swallow shape TASK-819 removed from `DocumentSection`. Whether it is equally lossy depends
on whether `ContextItem` still has a plaintext column (`field-encryption.ts:95` hints the Phase 6 PHI
models dropped theirs). **Not investigated** — many call sites, and outside TASK-819's scope.

## 5. Definition of Done
- [ ] An empty clinician edit clears the persisted body, or is refused — never commits state while retaining old text
- [ ] The misleading test asserts the persisted ciphertext, not merely that a write was attempted
- [ ] `deletion-without-contradiction` still distinguishes the machine writer from the clinician
- [ ] The `encryptBestEffort` family assessed, and either cleared or split into its own ticket

## 6. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Opened from the TASK-819 finding. |
