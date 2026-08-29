# TASK-819 — `DocumentSection` encryption failure is swallowed

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.2` |
| **Severity** | **High — silent loss of clinical content** |
| **Found by** | TASK-811 Lane D, 2026-08-29 (reported, deliberately not fixed in a persistence lane) |
| **Agent** | `debugger` · `opus` · **worktree** |

> Numbering note: 818 is the highest in `docs/implementation/`; `docs/archive/**` is off-limits this
> sprint, so 819 was assigned from the implementation tree alone.

## 1. Requirement Analysis

`DocumentSectionStore.encrypt()` catches an encryption failure, logs a warning, and **continues**.

`content` is transient — there is no plaintext column. So when Vault Transit is unavailable the
write proceeds and persists the **CONFIRMED state and a bumped revision** while `encryptedContent`
retains its **previous** value. The clinician receives `200 OK` and their text is gone.

Both writers are affected identically:
- the machine flush writer (`LiveDocumentationService.flush()`)
- the clinician edit route shipped by TASK-811 §8 (`PATCH .../sections/:sectionKey`)

This is why it was reported rather than patched inside Lane D: fixing it changes both lanes and
deserves its own change with its own tests.

## 2. What "completely and properly" requires

1. **A failed encryption must not commit.** No state transition, no revision bump, no `_version`
   bump, no sys-event. The row must be left exactly as it was.
2. **The caller must be told.** A write that did not persist returns an error, never `200`. Choose
   the status deliberately and justify it — a Vault outage is an upstream dependency failure, and
   `09-infrastructure-devops.md` §Configuration Tiers puts secrets at `failMode: closed`.
3. **The machine writer must degrade, not corrupt.** A flush that cannot encrypt must not silently
   publish a `section.patch` implying a persisted value.
4. **Never log section content**, in the failure path or anywhere else — it is PHI.
5. Prove it with a test that forces the encryption failure, not one that mocks the outcome.

## 3. Implementation Plan
_To be written by the implementing lane._

## 4. Implementation Summary
_Not started._

## 5. Definition of Done
- [ ] A forced encryption failure leaves the row byte-identical (state, revision, `_version`)
- [ ] The clinician route returns an error, never a success, when content did not persist
- [ ] The flush writer degrades without publishing a misleading patch
- [ ] No PHI in any log line on the failure path
- [ ] Test forces the real failure rather than asserting a mocked result

## 6. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket opened from the TASK-811 Lane D finding. |
