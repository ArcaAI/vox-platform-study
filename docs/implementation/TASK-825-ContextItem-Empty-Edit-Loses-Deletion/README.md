# TASK-825 — `ContextItem` empty edit loses the deletion, and writes a version row asserting it didn't

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `bugfix` |
| **Severity** | **High — silent loss of clinical content, plus a false immutable history row** |
| **Found by** | TASK-820 lane, 2026-08-30 |
| **Sibling of** | [TASK-820](../TASK-820-Empty-Section-Edit-Loses-Deletion/README.md) (merged — same defect, different model) |

## 1. The defect — verified, not inferred

`ContextItemRepository.encryptContentIntoEntity`
(`packages/domains/src/repositories/generated/core/ContextItemRepository.encryption.ts:93-96`)
carries the **identical** guard TASK-820 just removed from `DocumentSectionRepository`:

```ts
const result = await encryptStringToCiphertext(secrets, entity.content);
if (!result) return;                       // ← '' returns null, so the clear never happens
entity.encryptedContent = result.ciphertext;
```

`ContextItem` has **no plaintext column** (`consultation.prisma`: *"The plaintext `content` column has
been DROPPED"*), so `encryptedContent` is the only persisted form. Probed against a **working**
encryptor by the TASK-820 lane:

```
payload keys              = [currentVersionNumber, updatedBy]   ← no encryptedContent
entity.encryptedContent   = vault:v1:the-clinicians-summary     ← the OLD body, retained
```

## 2. Why this is worse than TASK-820 was

It is **reachable from the API**: `UpdateContextRequest.content` is `@IsOptional() @IsString()` with
no `@IsNotEmpty()`, so `PATCH` with `content: ''` reaches `ContextService.updateContext`, which
commits `currentVersionNumber`, `updatedBy`, the Qdrant re-sync marker — and **a new immutable
`ContextItemVersion` row asserting the content changed**, over text that was never deleted.

So the history record actively lies, and it is immutable. `HarnessInternalService`'s `existingDraft`
adoption branch has the same shape.

## 3. Why TASK-820 did not fix it here
Different model, different service, and a wider blast radius: `ContextItemVersion` history and Qdrant
sync, neither of which `DocumentSection` has. The fix is not a copy-paste of TASK-820's.

## 4. The `encryptBestEffort` premise was WRONG — do not chase it
TASK-820 §4 and TASK-819 both suggested `encryptBestEffort` (`summary.service.ts`,
`sttInternal.service.ts`, `ocr-enrichment.processor.ts`, `chain-summary.service.ts`) repeats the
swallow TASK-819 removed. **It does not.** Every one of those call sites delegates to
`encryptPhiFields` (`packages/applications/src/common/phi-field-encryption.ts`), which is
environment-gated and **rethrows** under `SECRETS_PROVIDER=vault` — set in `.env.dev`, `.env.test`
and `.env.sample`. The fail-closed posture is already the behaviour wherever PHI lives.

The real exposure is the **empty-write no-op above**, which needs no outage at all.

## 5. Definition of Done
- [ ] An empty `ContextItem` edit clears the persisted body, or is refused — never commits over retained text
- [ ] No `ContextItemVersion` row is written asserting a change that did not happen
- [ ] Qdrant sync reflects the true post-write state
- [ ] `HarnessInternalService`'s `existingDraft` adoption branch covered
- [ ] Test builds a REAL repository and asserts the persisted ciphertext — not a mock of the thing under test (the trap TASK-820 §2 documents)

## 6. Change History
| Date | Change |
|---|---|
| 2026-08-30 | Opened from the TASK-820 lane's probe. Orchestrator independently confirmed the identical guard at `ContextItemRepository.encryption.ts:94`. |
