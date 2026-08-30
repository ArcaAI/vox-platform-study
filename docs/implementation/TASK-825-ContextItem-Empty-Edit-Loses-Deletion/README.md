# TASK-825 — `ContextItem` empty edit loses the deletion, and writes a version row asserting it didn't

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-30 — merged to `dev-2.2`. Three layers, three different questions; two corrections to the brief in §7. |
| **Type** | `bugfix` |
| **Severity** | **High — silent loss of clinical content, plus a false immutable history row** |
| **Found by** | TASK-820 lane, 2026-08-30 |
| **Sibling of** | [TASK-820](../TASK-820-Empty-Section-Edit-Loses-Deletion/README.md) (merged — same mechanism, different model, **different disposition**) |
| **Agent** | `debugger` · `opus` · **worktree** `lane-825-contextitem` |

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

## 5. Implementation Plan (written before any code — reproduction first)

**Reproduced 2026-08-30** with a probe that drives the REAL `ContextService.updateContext` through
the REAL `ContextItemRepository` over a fake Prisma delegate, so the assertion is on the actual
Prisma payload (see §7 for the three corrections the probe made to this brief).

Three layers, because the ticket asks two different questions and the answers differ per lane:

| Layer | Question it answers | Change |
|---|---|---|
| `ContextService.updateContext` | Is an empty edit ALLOWED on this item? | **Refuse** for a `requiresContent` type, mirroring `addContext`'s existing guard verbatim — before any version row, `currentVersionNumber` bump or `updatedBy` stamp |
| `ContextItemRepository.encryptContentIntoEntity` | If an empty write IS allowed, is it PERSISTED? | `''` clears `encryptedContent` + `contentKeyVersion`; `undefined`/`null` still no-op |
| `HarnessInternalService.persistDraft` (adoption) | Should a degenerate empty model output overwrite a clinician-visible note? | **Skip the adoption**, log, continue — the same degrade-and-continue posture the branch already uses for OCC drift |

Tests: RED first, and the RED must be the bug COMMITTING — a real repository, real
`encryptStringToCiphertext`, real mapper, only persistence doubled, asserting the persisted
ciphertext.

## 6. Definition of Done
- [x] An empty `ContextItem` edit is **refused** on a `requiresContent` type and **clears** on a media
      type — never commits over retained text. RED was the bug COMMITTING: `promise resolved
      {currentVersionNumber: 4, version: 6}` on the refusal lane, and `expected Buffer[118,97,117,108,116,…]
      to be null` (`vault:v1:the-clinicians-summary`) on the clearing lane
- [x] No `ContextItemVersion` row is written asserting a change that did not happen — the refusal
      lands BEFORE `getLatestVersionNumber`, so no snapshot is inserted at all (`versions` is empty)
- [x] Qdrant sync — see §7 correction 2: the marker never reached the database in the first place,
      and no consumer reads it. Nothing to make true here; the real defect is filed separately
- [x] `HarnessInternalService`'s `existingDraft` adoption branch covered — an empty re-delivery now
      SKIPS the adoption rather than blanking the note
- [x] Tests build a REAL repository over a fake Prisma DELEGATE and assert the persisted payload —
      and each fix was reverted individually to prove its test catches the bug (§7)

## 7. What the fix actually was — and three corrections to the brief

### Correction 1 — the mechanism is confirmed, and it is one link
Probed by driving the REAL `ContextService.updateContext` through the REAL `ContextItemRepository`
over a fake Prisma delegate, so the observation is the payload Prisma was handed, not an inference:

```
PRISMA PAYLOAD   = { currentVersionNumber: 4, updatedBy: 'doctor-1', version: {increment: 1} }
ROW.encryptedContent = vault:v1:the-clinicians-summary     ← the OLD body, retained
VERSION ROW v4       = content '', encryptedContent null   ← history says "emptied"
MAPPER, clearing null= { encryptedContent: null, contentKeyVersion: null }
```

As in TASK-820, `AutoEntityChangeMapper`'s `if (result)` guard is NOT in the chain:
`encryptContentIntoEntity` returns before assigning, so `encryptedContent` never enters
`entity.changes`. When it IS explicitly nulled the generic pass carries it through (last line
above), so the mapper needs no change and the fix stays inside `ContextItem`.

### Correction 2 — the Qdrant re-sync marker is NOT written. It never was.
The brief says the empty edit "marks Qdrant re-sync on stale content". It marks nothing.
`markQdrantNeedsSync()` assigns `this._qdrantSynced = false` **before** calling
`setProperty('qdrantSynced', false)`, so `setProperty`'s `Object.is(currentValue, value)` guard sees
no change and records nothing — the column is absent from the payload above and the row still reads
`qdrantSynced: true` after the write. `markQdrantSynced()` has the identical shape. No production
code reads the column (only `ContextDtoMapper` echoes it into the response), so there is no stale
vector — but the API response says `false` while the row says `true`. Out of scope here; filed
separately.

### Correction 3 — the version row is not the layer that lies, and this is why TASK-820's fix is not a template
The `ContextItemVersion` snapshot records the NEW content, so on an empty edit it correctly reads
"empty at v4". It is the ITEM that keeps the old text; the immutable row asserts a deletion that
never landed. A repository-only fix WOULD make the two agree — so the brief's *"a repository-only
fix leaves a lying `ContextItemVersion` row"* is not the reason to go wider. The real reason is:

| | `DocumentSection` (TASK-820) | `ContextItem` (this ticket) |
|---|---|---|
| What a row is | a fixed slot in a document template | a discrete note |
| Deletion path | none — emptying IS the deletion | first-class `DELETE` → soft delete |
| Empty a legal state? | **yes** (TASK-811 §8b) | **no** — `addContext` refuses it, `ContextItemEntity.validate()` calls it invalid |
| Disposition | **persist the clearing** | **refuse the edit** (media types excepted) |

Clearing here would persist a row the CREATE path would have refused to create.

### The seam — three layers, because there are three different questions

| Layer | Question | Behaviour |
|---|---|---|
| `ContextService.updateContext` | Is an empty edit ALLOWED? | **No** for a `requiresContent` type — `BadRequestException('Content is required for non-media types')`, the CREATE path's rule verbatim, thrown before `getLatestVersionNumber` so nothing irreversible has happened |
| `ContextItemRepository.encryptContentIntoEntity` | If it IS allowed, is it PERSISTED? | `''` clears `encryptedContent` + `contentKeyVersion` as a pair; `undefined`/`null` still no-op (that is how a column-reconstituted row arrives) |
| `HarnessInternalService.persistDraft` (adoption) | Should a degenerate empty model output overwrite a clinician-visible note? | **Skip the adoption**, log, continue — the branch's existing OCC-drift posture |

**Why the service alone is not enough:** `encryptContentIntoEntity` has 14 production call sites, and
the harness adoption branch never goes through `updateContext`. **Why the repository alone is not
enough:** it would persist an invalid empty note on the API lane — and on the HARNESS lane it would
turn "silently keep the old note" into "blank the note", which is worse. That consequence is not
speculative: the domains test proves `content = ''` clears both columns into `changes`, and the
applications MEDIA test proves those nulls reach the Prisma payload; the harness branch feeds the
same entity through the same two steps. **Why the DTO is the wrong seam:** an `@IsNotEmpty()` on
`UpdateContextRequest.content` covers only the HTTP lane, cannot distinguish media from non-media,
and leaves the repository contract broken for every other caller.

### The test trap TASK-820 §2 documents
The sibling suite (`context.service.encryption.test.ts`) mocks `encryptContentIntoEntity`, so it
could never have caught this. The new `context.service.empty-edit.task825.test.ts` uses the REAL
service, REAL repository, REAL `encryptStringToCiphertext` and REAL mapper, doubling only the Prisma
DELEGATE, and asserts the payload Prisma received. **Each fix was reverted individually to prove its
test catches the bug:**

| Reverted | Result |
|---|---|
| repository fix only | domains `an EMPTY STRING clears…` ✗ · applications `MEDIA item…` ✗ · the two refusal tests still ✓ (the layers are independently load-bearing) |
| service guard only | `REFUSES an empty edit…` ✗ and `the refusal is the CREATE path's rule…` ✗ — *promise resolved instead of rejecting*, `currentVersionNumber: 4`, `version: 6` |
| harness guard only | `SKIPS the adoption…` ✗ — `updateWithVersion` called with `content: ''`, log line *"re-delivered — existing note updated in place"* |

### Files changed
| File | Change |
|---|---|
| `packages/domains/src/repositories/generated/core/ContextItemRepository.encryption.ts` | The persistence fix + a contract doc that no longer states the bug as a feature |
| `packages/applications/src/services/consultation/context/context.service.ts` | `updateContext` refuses an empty body on a `requiresContent` item, before any irreversible write |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `persistDraft` skips an empty adoption instead of stamping the row |
| `packages/domains/src/repositories/__tests__/ContextItemRepository.encryption.test.ts` | +3: `''` clears; `undefined`/`null` do not |
| `packages/domains/src/mappers/__tests__/ContextItemEntityMapper.encryptedContent.test.ts` | NEW — pins the fix's invisible dependency (the mapper carries a clearing null) |
| `packages/applications/.../context/__tests__/context.service.empty-edit.task825.test.ts` | NEW — the reproduction, real repository, asserts the Prisma payload |
| `packages/applications/.../harness/__tests__/harness-internal.service.test.ts` | +1: an empty re-delivery never touches the prior draft |

No schema, route, DTO or generated-artifact change — so no migration and no five-artifact regeneration.

### Gates
```
pnpm --filter @arcaai/domains build       → tsc, clean
pnpm --filter @arcaai/domains test        → 154 files | 1857 passed | 2 skipped | 9 todo   (was 1851)
pnpm --filter @arcaai/applications build  → tsc, clean
pnpm --filter @arcaai/applications test   → 618 files | 10543 passed | 4 skipped          (was 10537)
pnpm --filter @arcaai/api test            → 262 files | 4046 passed | 4 skipped
pnpm lint                                 → Tasks: 40 successful, 40 total · 0 errors
```
`context.service.ts`'s 6 `eslint-comments/require-description` warnings are pre-existing and merely
shifted line numbers — the `eslint-disable` count is 8 on `HEAD` and 8 now.

### Found in passing, NOT fixed here
1. **`markQdrantNeedsSync()` / `markQdrantSynced()` are inert** — see correction 2.
2. **`UpdateContextRequest.content` has no `@MaxLength`** while `AddContextRequest.content` carries
   `CONTEXT_CONTENT_MAX_LENGTH` (200k). The same create/update asymmetry as this ticket's defect,
   on the same DTO pair, bounding the same prompt-injection surface — but a different bug.

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-30 | Opened from the TASK-820 lane's probe. Orchestrator independently confirmed the identical guard at `ContextItemRepository.encryption.ts:94`. |
| 2026-08-30 | Reproduced independently at the Prisma-payload level; three brief corrections recorded (§7). Fixed across three layers — refuse (service), clear (repository), skip (harness). Each fix reverted individually to prove its test catches the bug. |

## 8. Three layers, and why the repository alone was not enough

**The orchestrator's brief was wrong about WHY TASK-820's fix is not a template.** It said blast
radius. The real reason is a **domain difference**:

| | `DocumentSection` | `ContextItem` |
|---|---|---|
| Deletion path | none — emptying **is** the deletion | first-class `DELETE` → soft delete |
| Is empty legal? | yes (TASK-811 §8b) | **no** — `addContext` already throws *"Content is required for non-media types"*, and `ContextItemEntity.validate()` agrees |

Clearing here would persist a row **the create path would have refused to create**. That
create/update asymmetry IS the bug.

| Layer | Question it answers |
|---|---|
| `ContextService.updateContext` | refuses an empty body on a `requiresContent` item, with the create path's message verbatim, BEFORE `getLatestVersionNumber`. Media types still clear |
| `ContextItemRepository.encryptContentIntoEntity` | `''` clears both columns as a pair; `undefined`/`null` still no-op. Needed because there are **14 production call sites** and the harness never goes through `updateContext` |
| `HarnessInternalService.persistDraft` | skips an empty adoption |

**The harness guard is the one that matters most, and the brief would have caused a regression
without it.** `HarnessDraftRequest.content` is `@IsString()` with no `@IsNotEmpty()`, and
`stripSegmentCitationMarkers` can reduce a marker-only note to `''`. A repository-only clear would
have taken that lane from "silently keeps the old note" to **"blanks a clinician-visible clinical
note"**. Nobody intended that deletion, so it skips and logs.

The DTO was the wrong seam: `@IsNotEmpty()` covers only the HTTP lane, cannot tell media from
non-media, and leaves the repository contract broken for every other caller.

## 9. Two corrections to the brief

1. **The `ContextItemVersion` row does NOT lie.** The snapshot records the new (empty) content
   correctly; it is the ITEM row that keeps the old text. So "a repository-only fix leaves a lying
   version row" was not the reason to go wider.
2. **The Qdrant marker is never written at all.** `markQdrantNeedsSync()` assigns
   `this._qdrantSynced = false` and THEN calls `setProperty` with the same value, so `Object.is`
   records nothing (`ContextItemEntity.ts:397-398`; orchestrator-verified). No stale vector — nothing
   reads it — but the API response contradicts the row. Filed separately.

Each of the three fixes was **reverted individually** to prove it load-bearing, and every RED was the
bug COMMITTING, not a stub rejecting. Tests use the real service/repository/encryptor/mapper with
only the Prisma delegate doubled — the sibling suite mocks `encryptContentIntoEntity` and could never
have caught this.

## 10. Also found, filed separately
`UpdateContextRequest.content` has **no `@MaxLength`** while `AddContextRequest.content` carries the
200k cap — the same create/update asymmetry, bypassing a bound that exists to limit the harness
prompt-injection surface.
