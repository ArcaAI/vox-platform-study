# TASK-655 — Collapse the Four-Way Live-Snapshot Resolver

- **Status:** Review
- **Type:** refactor
- **Requested:** 2026-08-11 (part of the TASK-654 execution plan, wave W0)
- **Base:** `dev-2.1` @ `a61df126b` (`feat(TASK-653): implement browser-extension origin support in the origin registry`)
- **Parent ticket:** [TASK-654 — Tenant-Defined Consultation Context & Reasoning Consultation Loop](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) §3.5, §6.1 (RK-1); [execution-plan.md](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md) §1 (agent contract), §3 (TASK-655 spec)

---

## 1. Requirement Analysis

There is exactly one correct implementation of "find the live SOAP snapshot for this
consultation" — `ContextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId,
secrets, { subType })` (`packages/domains/src/repositories/generated/core/ContextItemRepository.encryption.ts:117-132`).
Four call sites were named in the parent ticket as reimplementing it:

| Copy | Location |
|---|---|
| `findLiveSnapshotRow` | `live-documentation.service.ts` |
| `loadLiveSoapSnapshot` | `harness-internal.service.ts` |
| `resolveWarmStartPreSummary` | `summary.service.ts` |
| `resolveWarmStartPreSummary` | `summary.processor.ts` |

**Objective (from the parent spec):** replace all four with calls to the repository helper,
with **no observable behaviour change**. Any behavioural difference found between the
copies must be documented, not silently resolved.

**Hard constraints carried over from the parent ticket:**
- `readLiveAgentLineage` (`packages/applications/src/services/consultation/prompt/live-agent-lineage.ts:18-23`)
  stays the single reader of agent lineage — this change does not touch how lineage is read.
- The `LIVE_SOAP_SNAPSHOT` `subType` contract is unchanged.
- Do not touch `apps/harness/src/harness/temporal/workflows.py`.
- Do not touch `packages/agentic-sdk-v2/src/compat.ts` or `src/compat/**`.
- Never run `pnpm gen:mapper`.
- Never hard delete.

---

## 2. Current State Evaluation

Verified 2026-08-11 against `dev-2.1` @ `a61df126b`. File paths had drifted slightly from
the parent ticket's line-number citations (located by symbol name, not line number), and
one file lives in a different directory than cited: `live-agent-lineage.ts` is at
`packages/applications/src/services/consultation/prompt/live-agent-lineage.ts`, not under
`live-documentation/`.

### 2.1 The canonical helper (unchanged by this ticket)

`ContextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, secrets,
options?)` (`packages/domains/src/repositories/generated/core/ContextItemRepository.encryption.ts:117-132`):
1. `findPreSummaries(consultationId)` — every `PRE_SUMMARY` row for the consultation.
2. Filters by `metaData.subType === options.subType` when a `subType` is given; otherwise
   keeps every row (legacy "latest of any kind" behaviour).
3. Reduces to the newest by `createdAt` (`a.createdAt >= b.createdAt ? a : b`).
4. Decrypts: `secrets ? await this.decryptContentFromEntity(entity, secrets) : (entity.content ?? null)`.
5. Returns `{ entity: ContextItemEntity | null, plaintext: string | null }`.

This method already had thorough test coverage in
`packages/domains/src/repositories/__tests__/ContextItemRepository.encryption.test.ts`
(no snapshot, one snapshot, multi-row subType lever, no-secrets degrade). It was **not
modified** by this ticket except to add one new test (§4).

### 2.2 Verdict per call site

| Copy | Verdict | Action taken |
|---|---|---|
| `findLiveSnapshotRow` (`live-documentation.service.ts`) | Hand-rolled `findPreSummaries` + filter + reduce, no decrypt | **Refactored** — delegates to the helper |
| `loadLiveSoapSnapshot` (`harness-internal.service.ts`) | Hand-rolled `findPreSummaries` + filter + reduce, **plus** an explicit `decryptContentFromEntity` call and an in-place `entity.content =` mutation | **Refactored** — delegates to the helper, mutation contract preserved exactly (§3.2) |
| `resolveWarmStartPreSummary` (`summary.service.ts`) | Already called `findLatestPreSummaryWithDecryptedContent` twice (subType-filtered, then unfiltered fallback) — **no hand-rolled filter/reduce logic remained** | **No production change.** Verified via `git log` + code read; this call site was already fully collapsed before this ticket started (likely landed alongside the B-02/B-06 fix referenced in its own doc comments). Added the missing "decryption fails" characterisation test only (§4). |
| `resolveWarmStartPreSummary` (`summary.processor.ts`) | Byte-identical in shape to `summary.service.ts`'s version — already fully on the helper | **No production change**, same as above. Added the missing "decryption fails" characterisation test only (§4). |

So only **two** of the four call sites needed a production-code change; the other two were
already correctly collapsed onto the canonical helper and are now doubly evidenced by the
"decryption fails" tests added in this ticket.

---

## 3. Implementation Plan / Summary

### 3.1 `findLiveSnapshotRow` — `live-documentation.service.ts`

Before:
```ts
private async findLiveSnapshotRow(consultationId: string): Promise<ContextItemEntity | null> {
  if (!this.contextItemRepository) return null;
  const preSummaries = await this.contextItemRepository.findPreSummaries(consultationId);
  const snapshots = preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === 'LIVE_SOAP_SNAPSHOT');
  if (snapshots.length === 0) return null;
  return snapshots.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}
```

After:
```ts
private async findLiveSnapshotRow(consultationId: string): Promise<ContextItemEntity | null> {
  if (!this.contextItemRepository) return null;
  const { entity } = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, undefined, {
    subType: 'LIVE_SOAP_SNAPSHOT',
  });
  return entity;
}
```

`secrets` is passed as `undefined` deliberately: this caller only ever reads `.metaData`
off the row (agent lineage extraction in `readDurableAgentLineage`, and dedup identity in
`persistDurableSnapshotIfDue`) — never `.content` — so there is nothing to decrypt. The
helper degrades to `entity.content ?? null` for `plaintext` when `secrets` is `undefined`,
but that value is discarded here (only `entity` is destructured), so this is a pure
behaviour-preserving simplification, not a behavioural change.

Both existing call sites of `findLiveSnapshotRow` (`readDurableAgentLineage` and the
durable-snapshot dedup in `persistDurableSnapshotIfDue`) are untouched — they still call
`this.findLiveSnapshotRow(...)` exactly as before; only the private method's internals
changed.

### 3.2 `loadLiveSoapSnapshot` — `harness-internal.service.ts`

Before:
```ts
private async loadLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
  const preSummaries = await this.contextItemRepository.findPreSummaries(consultationId);
  const snapshots = preSummaries.filter((p) => (p.metaData as Record<string, unknown> | undefined)?.subType === 'LIVE_SOAP_SNAPSHOT');
  if (snapshots.length === 0) return null;
  const entity = snapshots.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
  if (this.secretsService) {
    entity.content = await this.contextItemRepository.decryptContentFromEntity(entity, this.secretsService);
  }
  return entity;
}
```

After:
```ts
private async loadLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
  const { entity, plaintext } = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, this.secretsService, {
    subType: 'LIVE_SOAP_SNAPSHOT',
  });
  if (entity && this.secretsService) {
    entity.content = plaintext;
  }
  return entity;
}
```

**Behavioural note (not a difference, a preserved contract).** The original mutated
`entity.content` in place **only when `this.secretsService` was truthy**, leaving it
untouched otherwise (relying on whatever the process-wide decrypt-on-read wrap already
populated). The helper itself computes `plaintext` unconditionally (falling back to
`entity.content ?? null` when no secrets are passed), so a naive `entity.content =
plaintext` unconditionally would have been *harmless* in every test scenario observed —
but to keep the contract byte-identical rather than merely equivalent-in-practice, the
`this.secretsService` guard was kept explicit. Two callers read the result
(`assemble()` via `liveSnapshot?.content`, `persistDraft()` via `liveSnapshotRow.id` and
`readLiveAgentLineage(liveSnapshotRow)`), both unchanged.

### 3.3 `resolveWarmStartPreSummary` — `summary.service.ts` and `summary.processor.ts`

No production change. Both already read:
```ts
const snapshot = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, this.secretsService, {
  subType: 'LIVE_SOAP_SNAPSHOT',
});
if (snapshot.entity) {
  return { text: snapshot.plaintext, lineage: readLiveAgentLineage(snapshot.entity), snapshotId: snapshot.entity.id };
}
const legacy = await this.contextItemRepository.findLatestPreSummaryWithDecryptedContent(consultationId, this.secretsService);
return { text: legacy.plaintext, lineage: readLiveAgentLineage(legacy.entity), snapshotId: legacy.entity?.id ?? null };
```
i.e. two calls to the canonical helper (subType-filtered, then an unfiltered legacy
fallback) — no hand-rolled find/filter/reduce logic left to collapse. This matches the
parent ticket's own hedge ("uses the repo helper already in part — verify").

### 3.4 Behavioural differences found between the four copies

One real (already-resolved, pre-existing) difference was found, not introduced by this
ticket:

- `findLiveSnapshotRow` never decrypted (by design — it only reads `.metaData`).
- `loadLiveSoapSnapshot` always decrypted when a `SecretsService` was wired.
- `resolveWarmStartPreSummary` (both copies) always decrypted via the helper.

**Decision:** preserved every call site's existing decrypt behaviour exactly (documented
per-site in §3.1–§3.3) rather than normalising them, per the ticket's explicit instruction
("If you find a behavioural difference between the four copies, do NOT silently pick one
— document the difference … and call it out explicitly as a decision"). `findLiveSnapshotRow`
continues to never decrypt (it doesn't need to); `loadLiveSoapSnapshot` continues to decrypt
only when a `SecretsService` is wired; the two `resolveWarmStartPreSummary` copies continue
to always route through the helper's own secrets-optional decrypt path. No caller's
observable output changed.

### 3.5 Test changes

**TDD approach used:** this is a characterisation refactor (ticket explicitly says
"green-before is correct here"). For each call site, existing tests were run against the
current (pre-refactor) implementation first to confirm they already pinned the target
behaviour; new tests were added only where a gap existed (the "decryption fails" scenario,
absent from all four call sites' suites before this ticket), and those were also confirmed
to pass against the pre-refactor code before the refactor landed (both `loadLiveSoapSnapshot`
and the two `resolveWarmStartPreSummary` copies had no try/catch around the snapshot load,
so a decrypt failure already propagated as a rejected promise — the new tests pin that
pre-existing, unwrapped behaviour, not a new one).

**Mock repository shape change (mechanical, required by the refactor).** Several test files
construct a hand-rolled fake `ContextItemRepository` that implemented `findPreSummaries`
but not `findLatestPreSummaryWithDecryptedContent`. Once `findLiveSnapshotRow` /
`loadLiveSoapSnapshot` started calling the latter, those fakes needed a
`findLatestPreSummaryWithDecryptedContent` implementation — added as a **delegate** that
calls the SAME `findPreSummaries` mock (and `decryptContentFromEntity` mock, where present)
each test already configures, replicating the real helper's filter + reduce + decrypt
logic. This means every pre-existing `mockResolvedValue`/`mockImplementation` call on
`findPreSummaries` continues to drive the same downstream behaviour — no test's assertions
or setup needed to change, only the fixture needed the new method added.

Files touched, and why:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | `findLiveSnapshotRow` refactor (§3.1) |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `loadLiveSoapSnapshot` refactor (§3.2) |
| `packages/domains/src/repositories/__tests__/ContextItemRepository.encryption.test.ts` | + "propagates a decryption failure rather than swallowing it" test for the shared helper |
| `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts` | Mock repo gains `findLatestPreSummaryWithDecryptedContent` delegate; + "propagates a decryption failure from the snapshot load" test |
| `packages/applications/src/services/consultation/harness/__tests__/harness-internal.governance-wave2.test.ts` | Mock repo gains the delegate (no behaviour test change — this suite doesn't exercise the snapshot path, added defensively since production code now calls the method unconditionally on the `assemble`/`persistDraft` paths) |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` | Central `buildDeps` factory wraps every `contextItemRepository` fixture (default and `opts`-supplied) with the delegate — covers all describe blocks in this file, including the "durable snapshot" and "single-owner lock" suites that directly exercise `findLiveSnapshotRow` |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.agent-freeze.test.ts` | Inline repo fixture gains the delegate (the C5 lineage hand-off test exercises `findLiveSnapshotRow` via `stop({ persistSnapshot: true })`) |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.repoint-grounding.test.ts` | Inline repo fixture gains the delegate |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.groundedness.test.ts` | Inline repo fixture gains the delegate (defensive; not currently exercised) |
| `packages/applications/src/services/consultation/summary/__tests__/summary.service.warm-start-decrypt.task635.test.ts` | + "propagates a decryption failure rather than swallowing it" test |
| `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.lineage.task635.test.ts` | + "propagates a decryption failure rather than swallowing it" test |

**`findLiveSnapshotRow`'s "decryption fails" scenario.** Not applicable — this call site
never decrypts (§3.1), so there is no decrypt-failure path to test at that call site
specifically. The shared helper's decrypt-failure behaviour is pinned once, authoritatively,
in `ContextItemRepository.encryption.test.ts` (used by all four call sites); the two call
sites that DO decrypt (`loadLiveSoapSnapshot`, both `resolveWarmStartPreSummary` copies)
each get their own propagation test at their own layer.

---

## 4. TDD List — Coverage Map

Per the ticket's TDD list ("A test proving all four call sites return identical results
for: no snapshot; one snapshot; multiple `PRE_SUMMARY` rows where only one carries
`subType = LIVE_SOAP_SNAPSHOT`; a snapshot whose decryption fails"):

| Scenario | Repo helper (shared impl) | `findLiveSnapshotRow` | `loadLiveSoapSnapshot` | `resolveWarmStartPreSummary` (service) | `resolveWarmStartPreSummary` (processor) |
|---|---|---|---|---|---|
| No snapshot | ✅ pre-existing | ✅ pre-existing (durable-snapshot "create" path) | ✅ pre-existing ("omits preSummaryText…") | ✅ pre-existing ("leaves preSummaryText undefined…") | ✅ pre-existing ("leaves both lineage fields undefined…") |
| Exactly one snapshot | ✅ pre-existing | ✅ pre-existing (agent-freeze C5 hand-off test) | ✅ pre-existing ("injects the LIVE_SOAP_SNAPSHOT content…") | ✅ pre-existing ("populates preSummaryText…") | ✅ pre-existing ("reads the LIVE_SOAP_SNAPSHOT through decrypting accessor…") |
| Multiple `PRE_SUMMARY` rows, one subType lever | ✅ pre-existing | ✅ pre-existing ("dedups by subType so a newer NON-live PRE_SUMMARY cannot spawn a duplicate…") | ✅ pre-existing ("selects the latest LIVE_SOAP_SNAPSHOT when multiple PRE_SUMMARY rows exist…") | ✅ pre-existing ("prefers the snapshot over a newer case-notes pre-summary (B-06)…") | ✅ pre-existing ("falls back to the latest pre-summary of ANY subType…") |
| Decryption fails | ✅ **added** ("propagates a decryption failure rather than swallowing it") | N/A — never decrypts (§3.5) | ✅ **added** ("propagates a decryption failure from the snapshot load…") | ✅ **added** ("propagates a decryption failure rather than swallowing it") | ✅ **added** ("propagates a decryption failure rather than swallowing it (re-thrown after job-failure bookkeeping)") |

---

## 5. Gates — actual output

Worktree bootstrap note: this worktree had no `node_modules`, no generated Prisma client,
and no built workspace packages. `pnpm install`, `pnpm db:generate`, and builds of every
upstream dependency (`@arcaai/exceptions`, `@arcaai/database`, `@arcaai/types`,
`@arcaai/utils`, `@arcaai/room`, `@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt`,
`@arcaai/med-ner`, `@arcaai/pipeline`, `@arcaai/vox`, `@arcaai/ui`) were run first so the
gates below reflect real build/test results, not missing-artifact noise. `.env.dev` /
`.env.test` were copied from the sibling main checkout (both gitignored, untracked —
`git status --short` confirms neither is staged).

### `pnpm --filter @arcaai/domains build`

```
> @arcaai/domains@0.0.1 build
> tsc

(clean — no output, exit 0)
```

### `pnpm --filter @arcaai/domains test`

```
 Test Files  137 passed | 2 skipped (139)
      Tests  1564 passed | 2 skipped | 9 todo (1575)
```
(1564 = the pre-existing 1563 passing tests + 1 new "propagates a decryption failure" test
on `findLatestPreSummaryWithDecryptedContent`.)

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc

(clean — no output, exit 0)
```

### `pnpm --filter @arcaai/applications test`

```
 Test Files  452 passed | 1 skipped (453)
      Tests  8580 passed | 4 skipped (8584)
```
(8580 = the pre-existing 8577 passing tests + 3 new "propagates a decryption failure" tests,
one each at `harness-internal.service.ts`, `summary.service.ts`, `summary.processor.ts`.)

### `pnpm test:unit`

Two phases (root `package.json`): a workspace-wide `vitest run`, then
`pnpm --filter @arcaai/ui --filter @arcaai/vox --filter @arcaai/compat-playground --filter @arcaai/admin-console test`.

```
Workspace vitest run:
 Test Files  956 passed | 2 skipped (958)
      Tests  16323 passed | 4 skipped | 9 todo (16336)

packages/ui test:              Test Files  242 passed (242)   Tests  656 passed (656)
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   Tests  4131 passed (4131)
apps/compat-playground test:   Test Files  21 passed (21)     Tests  223 passed (223)
apps/admin-console test:       Test Files  172 passed (172)   Tests  1334 passed (1334)
```
All green — zero failures across the whole monorepo.

### `pnpm lint`

```
 Tasks:    32 successful, 32 total
Cached:    0 cached, 32 total
```
Pre-existing `eslint-comments/require-description` / `@typescript-eslint/no-unused-vars`
warnings are present in unrelated files across the monorepo (verified: none of them
reference `live-documentation.service.ts`, `harness-internal.service.ts`,
`ContextItemRepository.encryption.ts`, or any of the test files this ticket touched — 0
warnings, 0 errors on every file this ticket changed). No new warnings introduced.

---

## 6. Files Changed

- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` — `findLiveSnapshotRow` refactor
- `packages/applications/src/services/consultation/harness/harness-internal.service.ts` — `loadLiveSoapSnapshot` refactor
- `packages/domains/src/repositories/__tests__/ContextItemRepository.encryption.test.ts` — decrypt-failure test
- `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts` — mock delegate + decrypt-failure test
- `packages/applications/src/services/consultation/harness/__tests__/harness-internal.governance-wave2.test.ts` — mock delegate
- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` — mock delegate (central factory)
- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.agent-freeze.test.ts` — mock delegate
- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.repoint-grounding.test.ts` — mock delegate
- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.groundedness.test.ts` — mock delegate
- `packages/applications/src/services/consultation/summary/__tests__/summary.service.warm-start-decrypt.task635.test.ts` — decrypt-failure test
- `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.lineage.task635.test.ts` — decrypt-failure test

No migration, no API change, no barrel/module registration change (no new
entity/factory/mapper/repository, no new service). Pure internal refactor + test
additions.

## 7. Change History

- 2026-08-11 — Ticket implemented. Explored all four call sites; found two
  (`summary.service.ts`, `summary.processor.ts`) were already fully collapsed onto the
  canonical repository helper before this ticket started. Refactored the remaining two
  (`live-documentation.service.ts`'s `findLiveSnapshotRow`,
  `harness-internal.service.ts`'s `loadLiveSoapSnapshot`) to delegate to
  `ContextItemRepository.findLatestPreSummaryWithDecryptedContent`, preserving each call
  site's exact pre-existing decrypt behaviour (documented in §3.4 as a decision, not a
  silent normalisation). Added the one missing TDD scenario (decryption failure
  propagation) across all applicable layers. All gates green — see §5 for pasted output.
