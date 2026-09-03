# TASK-819 — `DocumentSection` encryption failure is swallowed

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-29 — merged to `dev-2.2`. A second, distinct defect found on the same rows: see TASK-820. |
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

## 3. Implementation Summary

`encrypt()` in `section-store.ts` **no longer catches**. Four lines of behaviour change plus the
rationale. Both writers' existing catch blocks already convert a non-OCC throw to `unavailable`,
which delivered all three requirements without new machinery: nothing commits (the throw precedes
`create`/`updateWithVersion`), the clinician route **503s**, and `publishSectionPatches` publishes
nothing because it only publishes on `applied === true`. No new refusal reason, no route or DTO
change, so no five-artifact regeneration.

**503, deliberately.** `downstream-error.ts` classifies `transport` — "the gateway never reached the
peer" — as 503, the retry-me case that RFC 9110 pairs with `Retry-After`, and reserves 502 for
"reached it and got garbage". A Vault Transit outage is the former, and retry is correct because the
clinician's text is still in their editor. Not 500, which says "our bug, retrying won't help". It
also reuses the contract TASK-811 §8b already documented — encryption IS persistence here, since
ciphertext is the only persisted form.

**Two corrections to the original diagnosis:**
1. **The create branch is affected too, and loses differently** — `encryptedContent` is never
   assigned, so the row is born with a permanently NULL body rather than reverting to older text.
2. The swallow was **narrower** than "any Vault problem" in one way that mattered:
   `encryptStringToCiphertext` returns `null` (no throw) for empty content, so the legitimate
   empty-write no-op is not a failure. A naive "throw if no ciphertext" would have broken the
   clinician's authorized deletion.

**The failure was forced, not mocked:** a real `VaultSecretsProvider` at `http://127.0.0.1:1`, the
real `SecretsService`, and the real repository encryption. A test asserts `provider.boot()` genuinely
rejects against a live socket. Only persistence is a double — necessarily, since "the row was left as
it was" is the assertion — and it stores column snapshots so an in-memory mutation cannot masquerade
as a landed write. Stated limitation: `ensureBooted()` throws one frame before the socket write.

The three adjacent refusals hold, and structurally cannot be disturbed:
`deletion-without-contradiction` and `confirmed-no-overwrite` both return BEFORE the try block, and
`expectedVersion` is consumed by `updateWithVersion`, AFTER `encrypt()`. One consequence named: with
Vault down AND a stale `If-Match` the store yields 503 rather than 412 — correct, since 412 would
send a client into a retry that must also fail.

**PHI audit:** no log line on or around the failure path carries `content`; a test captures
`warn`/`log`/`error`/`debug`/`verbose` and asserts the body never appears. Observation, not a change:
`toObject()` does not honour `@Secret()` — it only strips underscores — so anyone assuming entity
serialisation self-redacts would be wrong. Nothing on this path serialises an entity.

## 3a. Original Implementation Plan
_Written by the implementing lane; see §3._



## 5. Definition of Done
- [x] A forced encryption failure leaves the row byte-identical — RED: `FLUSH: leaves the row byte-identical` failed with `applied: true` (the bug reproducing, not a stub rejecting)
- [x] The clinician route 503s — RED: `503s — it does not answer 200 for content that was never stored`
- [x] The flush writer publishes nothing — `publishSectionPatches` only publishes on `applied === true`
- [x] No PHI on the failure path — asserted across all five log levels
- [x] Real `VaultSecretsProvider` against a dead socket; `boot()` proven to reject

## 6. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket opened from the TASK-811 Lane D finding. |
| 2026-08-29 | Fixed and merged. Gates: applications 10447, api 4046, lint 40/40. Second defect on the same rows split out as TASK-820. |
