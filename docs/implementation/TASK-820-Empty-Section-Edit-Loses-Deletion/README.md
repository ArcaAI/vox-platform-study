# TASK-820 — An empty section edit silently loses the deletion

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-30 — merged to `dev-2.2`. The `ContextItem` instance split out as TASK-825. |
| **Type** | `bugfix` |
| **Severity** | **High — silent loss of clinical intent, no outage required** |
| **Found by** | TASK-819 lane, 2026-08-29, while fixing the adjacent swallow |
| **Depends on** | TASK-819 (merged) |
| **Agent** | `debugger` · `opus` · **worktree** `lane-820-emptyedit` |

## 1. The defect

A clinician **emptying** a section loses the deletion. No Vault outage is involved — this happens
against a fully working encryptor.

`encryptStringToCiphertext` returns `null` for `''`, so `encryptContentIntoEntity` no-ops. The **old
ciphertext stays** while `state`, `revision` and `_version` all advance. On reload the deleted text
reappears.

**Correction to the mechanism as first written** (probed, not reasoned — see §3):
`AutoEntityChangeMapper`'s `if (result) model[key] = result` guard is NOT part of the chain. The
defect is one link, not two: because `encryptContentIntoEntity` returns before assigning,
`encryptedContent` never enters `entity.changes` at all, so the mapper emits a payload with no
`encryptedContent` key and the UPDATE simply omits the column. Probed payloads:

```
clinician empties a section, pre-fix:
  changes  = [content, revision, state, confirmedAt, confirmedBy]   // no encryptedContent
  payload  = [revision, state, confirmedAt, confirmedBy]            // content has no column
```

The distinction MATTERS, because it decides the seam: a mapper that dropped clearing nulls would
have forced a fix in `AutoEntityChangeMapper` affecting every `@Secret()` field on every model. It
does not drop them — when `encryptedContent` IS explicitly nulled, the generic pass above the
custom-mapping pass has already copied it and the payload carries `encryptedContent: null` plus
`contentKeyVersion: null`. So the mapper needs no change, and the fix stays inside `DocumentSection`.

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

## 3. Implementation Summary

**The decision: an empty write NULLS `encryptedContent`. It is not refused.** Refusing would
contradict TASK-811 §8b — a clinician emptying their own section is authorized by definition — and
TASK-819 already recorded that a naive "throw when there is no ciphertext" breaks exactly that. So
the deletion is persisted, not rejected.

**The seam: `DocumentSectionRepository.encryptContentIntoEntity`** (`packages/domains`), five lines.
That function is the one place that owns "make `encryptedContent` agree with `content`", and its old
contract — *"No-op when `content` is empty/null, so it is safe to call unconditionally"* — is the bug
stated as a feature: a no-op is only safe on a row that has no ciphertext yet. It now separates the
two cases `encryptStringToCiphertext` collapses into one `null`:

| `entity.content` | Meaning | Behaviour |
|---|---|---|
| a non-empty string | new body | encrypt and store (unchanged) |
| `undefined` / `null` | the caller has no opinion about the body | no-op (unchanged) |
| `''` | the body is now empty | clear `encryptedContent` **and** `contentKeyVersion` |

Only an empty STRING clears. `undefined`/`null` deliberately do not, because that is how a row
reconstituted from columns arrives — there is no `content` column to hydrate — and treating that as
a deletion would blank the body of every section touched by a write that never mentioned it.

**Why that breadth is right.** Three seams were available:

| Seam | Breadth | Verdict |
|---|---|---|
| `AutoEntityChangeMapper`'s `if (result)` guard | every `@Secret()` field on every model | Wrong, and unnecessary — it is not in the chain (§1) |
| `DocumentSectionStore` | the clinician lane only | Too narrow — it would leave the machine lane lossy |
| `DocumentSectionRepository.encryptContentIntoEntity` | `DocumentSection` only | **Chosen** |

The middle row is the one that matters. An AUTHORIZED machine deletion — a flush that empties a
section and DOES name a transcript contradiction — loses the deletion identically. That second
instance was not in the ticket; it was found by writing the test. A fix in the store's clinician path
would have shipped green while the machine lane stayed broken.

**The machine/clinician distinction is untouched.** `deletion-without-contradiction` decides WHETHER
a deletion is allowed; this decides whether an allowed deletion is PERSISTED. They are orthogonal,
and the guard is structurally out of reach: it returns from `applyFlushPatch` before the try block
that reaches the encryptor. A test pins that an unjustified flush deletion is still refused with the
row's ciphertext intact, alongside the test that an authorized one now clears it.

### The test that gave false assurance

`"accepts an EMPTY edit …"` mocked `encryptContentIntoEntity` and asserted only that a write was
attempted, so it passed throughout the defect's life. It now builds a REAL `DocumentSectionRepository`
(production `encryptContentIntoEntity`, real `encryptStringToCiphertext`) with only persistence
doubled — the shape the TASK-819 block in the same file already uses — and asserts the
`encryptedContent`/`contentKeyVersion` actually handed to `updateWithVersion`. **Verified by
reverting the fix: it fails on the ciphertext assertion, and the other 14 tests in the file still
pass.**

One dependency of that assertion is invisible from the applications layer — that the mapper carries
a clearing null through to Prisma — so it is pinned where it lives, in
`DocumentSectionEntityMapper.encryptedContent.test.ts`. That test was green from the start; it is a
regression pin, not a reproduction.

## 4. `encryptBestEffort` — ASSESSED. The premise was wrong; a DIFFERENT defect is real

**Cleared: `encryptBestEffort` is not the swallow TASK-819 removed.** Every one of those call sites
delegates to `encryptPhiFields` (`packages/applications/src/common/phi-field-encryption.ts`), which
is environment-gated: with `SECRETS_PROVIDER=vault` it **rethrows** so the caller's write aborts, and
it swallows only when the provider is not Vault. `SECRETS_PROVIDER=vault` is set in `.env.dev`,
`.env.test` and `.env.sample`. So the fail-closed posture TASK-819 demanded is already the behaviour
in every environment that holds PHI, and the swallow survives only where policy says there is no real
PHI to lose. This is materially unlike `DocumentSectionStore.encrypt()`, whose `try/catch` swallowed
unconditionally, in production included. **Do not re-open this half.**

**Split out: `ContextItem` carries the TASK-820 defect itself.** `ContextItem` has no plaintext
column (`consultation.prisma`: *"The plaintext `content` column has been DROPPED"*), and
`ContextItemRepository.encryptContentIntoEntity` still holds the identical `if (!result) return;`.
Probed against a WORKING encryptor — emptying an existing item yields:

```
payload keys = [currentVersionNumber, updatedBy]     // no encryptedContent
entity.encryptedContent = vault:v1:the-clinicians-summary   // the OLD body, retained
```

Reachable, not theoretical: `UpdateContextRequest.content` is `@IsOptional() @IsString()` with no
`@IsNotEmpty()`, so `PATCH` with `content: ''` reaches `ContextService.updateContext`, which commits
`currentVersionNumber`, `updatedBy`, the Qdrant re-sync marker and a new immutable `ContextItemVersion`
row asserting the content changed — over the undeleted text. `HarnessInternalService`'s
`existingDraft` adoption branch has the same shape.

**Not fixed here, deliberately.** It is a different model, a different service, a different blast
radius (`ContextItemVersion` history rows and Qdrant sync are implicated, neither of which
`DocumentSection` has), and the fix needs its own tests. Needs its own ticket.

## 5. Definition of Done
- [x] An empty clinician edit clears the persisted body — RED: `expected Buffer[…] to be null` while
      `applied: true`, `state: CONFIRMED`, `revision: 4`, `version: 5` (the bug reproducing against a
      WORKING encryptor, not a stub rejecting)
- [x] The misleading test asserts the persisted ciphertext — and was proven to fail against the
      reverted fix, so it can no longer pass over the bug
- [x] `deletion-without-contradiction` still distinguishes the machine writer from the clinician —
      pinned in both directions (an authorized deletion clears; an unjustified one is refused with the
      ciphertext intact)
- [x] `encryptBestEffort` assessed — the swallow is CLEARED (env-gated, fail-closed under
      `SECRETS_PROVIDER=vault`); a distinct `ContextItem` defect found, evidenced, and split out (§4)

### Files changed
| File | Change |
|---|---|
| `packages/domains/src/repositories/generated/core/DocumentSectionRepository.ts` | The fix: `''` clears `encryptedContent` + `contentKeyVersion`; `undefined`/`null` still no-op |
| `packages/domains/src/mappers/__tests__/DocumentSectionEntityMapper.encryptedContent.test.ts` | NEW — pins that the mapper carries a clearing null (the fix's invisible dependency) |
| `packages/applications/.../realtime/__tests__/section-store.empty-edit.test.ts` | NEW — the reproduction, both lanes, plus the refusal guard |
| `packages/applications/.../document-section/__tests__/document-section.service.test.ts` | The false-assurance test replaced with one that asserts the persisted ciphertext |

No schema, route, DTO or generated-artifact change — so no migration and no five-artifact regeneration.

## 6. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Opened from the TASK-819 finding. |
| 2026-08-30 | Fixed at the repository seam. Mechanism corrected (the mapper is not in the chain) and a second lossy lane found (authorized machine deletion). `encryptBestEffort` cleared; a `ContextItem` instance of the same defect split out. |

## 7. What the fix actually was — and two corrections to the brief

**The defect was ONE link, not two.** The brief said `AutoEntityChangeMapper`'s `if (result)` guard
was the blocker. It is not: `encryptContentIntoEntity` returns **before assigning**, so
`encryptedContent` never enters `changes` and the UPDATE simply omits the column. When it IS
explicitly nulled, the mapper carries it through. Proven by probing the mapper directly:

```
clinician empties a section, pre-fix:
  entity.changes = [content, revision, state, confirmedAt, confirmedBy]   ← no encryptedContent
  prisma payload = [revision, state, confirmedAt, confirmedBy]            ← content has no column
```

**That correction chose the seam.** Had the mapper dropped clearing nulls, the fix would have had to
live in `AutoEntityChangeMapper` — every `@Secret()` field on every model.

**The store would have been too narrow, and the test proved it.** An AUTHORIZED machine deletion — a
flush that empties a section and DOES name a transcript contradiction — lost it identically. That
second lossy lane is not in the ticket. A fix in `DocumentSectionStore.applyClinicianEdit` would have
shipped green with the machine lane still broken.

**The fix**, in `DocumentSectionRepository.encryptContentIntoEntity`, separates the two cases
`encryptStringToCiphertext` collapses into one `null`: `undefined`/`null` → no-op (unchanged — that
is how a column-reconstituted row arrives); `''` → clear `encryptedContent` + `contentKeyVersion` as
a pair. The old contract stated the bug as a feature: *"No-op when `content` is empty/null, so it is
safe to call unconditionally."* A no-op is only safe on a row with no ciphertext yet.

**The false-assurance test** now builds a REAL repository with only persistence doubled, and asserts
the ciphertext handed to `updateWithVersion`. The lane verified it catches the bug by reverting the
fix and rebuilding.

**Machine vs clinician holds.** `deletion-without-contradiction` decides WHETHER a machine deletion
is allowed; this fix decides whether an allowed one is PERSISTED. Orthogonal, and the guard is
structurally out of reach — it returns from `applyFlushPatch` before the try block.

Gates: domains 1851 · applications 10537 · api 4046 · lint 40/40.

**Fresh-worktree trap worth knowing:** `@arcaai/async-contract` needs building alongside
`pnpm db:generate`, or 5 api suites fail at collection with `Failed to resolve entry for package` —
0 failed tests, which makes it look like a real failure and is not.
