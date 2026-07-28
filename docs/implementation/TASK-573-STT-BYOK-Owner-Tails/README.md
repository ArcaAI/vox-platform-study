# TASK-573 — STT BYOK: Owner Tails (Design Gate, Migration, Live E2E)

- **Status**: Pending
- **Type**: verification / docs
- **Program**: [Unified Provider-Connection Plane](../SOTA-Track/2026-07-28-unified-provider-plane-program.md) — Wave 0 (independent, starts day 1)
- **Branch of record**: `thuynh/2607`
- **Size**: S–M · **Wave**: 0 · **Depends on**: nothing (closes TASK-567's open tails)
- **Runs fully parallel** — no code-file overlap with any other lane.

> This ticket clears the three owner tails TASK-567 left open (its README, status *Review*). It touches docs, a design decision, and test execution — **not** the credential-storage refactor (that is TASK-571).

## Agent execution

| Phase | Tier | Goal |
|---|---|---|
| Discovery | **claude-sonnet-5-low** | Read TASK-567 README §Phase G + the `stt-config` screen; confirm it composes only already-approved patterns (`ScreenTemplate`, TTS `CredentialCard` tab verbatim, `EffectiveLine`). Enumerate the exact e2e spec(s) and the migration to apply. |
| Implementation | **claude-sonnet-5-high** for the migration apply + e2e run; **claude-sonnet-5-xhigh** for the design-gate decision (waiver text vs escalate for a Figma frame) | Resolve the rule-12 gate, apply the migration to the test DB, execute the authored fallback e2e against a live stack, capture evidence. |
| Review/close | **claude-sonnet-5-xhigh** | Confirm the waiver is recorded correctly (or a frame is linked), the migration applied cleanly, and the e2e output is real + green; flip TASK-567 to Completed. |

**Ownership (exclusive):** `docs/implementation/TASK-567/**`, the STT fallback e2e specs (`apps/api/tests/e2e/stt-fallback-*.spec.ts`), and any Figma/waiver record. **Do NOT** modify STT app/service code (TASK-571 owns the credential lane; the fallback code is frozen).

## 1. Requirement Analysis
Close the three TASK-567 owner tails so STT BYOK + fallback is fully verified and mergeable on its own merits:
1. **Rule-12 design gate** on the `stt-config` screen — obtain an approved Figma frame OR record an owner waiver (TASK-526 precedent: waiver acceptable when the screen composes only already-approved patterns). Remove the `⚠️ DESIGN GATE OPEN — DO NOT MERGE` header and restore the nav entry once cleared.
2. **Apply the TASK-567 migration** to the test DB (5433) and confirm drift checks green.
3. **Run the authored fallback e2e** (`stt-fallback-cross-tenant.spec.ts`) against a live stack; capture output.

## 2. Current State Evaluation (2026-07-28)
- TASK-567 README status *Review*; §Phase G notes the screen carries the DO-NOT-MERGE header and is omitted from nav pending the gate.
- Migration authored but not applied to the test DB; e2e authored but not executed against a live stack (per the README's owner-tail list).
- The screen composes `ScreenTemplate` + the TTS `CredentialCard` tab verbatim → a waiver is the reasonable ask (program §2.2, TASK-526 precedent).

## 3. Implementation Plan
1. **Design gate**: draft the waiver entry (verbatim, dated, in the TASK-567 README, mirroring TASK-526's recorded waiver) for owner sign-off; if the owner prefers a frame, escalate and pause this step only (the other two proceed). On clearance: remove the DO-NOT-MERGE header, restore the `stt-config` nav entry.
2. **Migration**: `pnpm infra:test:up` + apply; `pnpm --filter @arcaai/database test`; confirm `generate-*-check` + enum-parity green.
3. **E2E**: bring up the stack (`pnpm test:up:api` + STT), run `stt-fallback-cross-tenant.spec.ts`; capture pass output; if it needs a stubbed cloud provider, document the stub.
4. Update TASK-567 README Implementation Summary + Change History; set status Completed when all three clear.

## 4. Verification
- Waiver text recorded (or frame linked) + header/nav restored.
- Migration applied: psql/`migrate-status` clean; drift checks green (paste output).
- E2E: real green output pasted.

## 5. Implementation Summary
_(fill on completion.)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | platform review | Ticket authored (Wave 0 STT owner tails). |
