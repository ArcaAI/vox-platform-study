# TASK-1040 — Temporal payload codec for PHI at rest

**Status:** Pending. Raised on 2026-10-04 (TASK-1036 OD-27). Not scheduled in the TASK-1036/1038 waves; it needs its own design and owner decisions.
**Type:** infrastructure / compliance
**Branch:** dev-2.2
**Raised:** 2026-10-04

## 1. Requirement Analysis

The harness Temporal client uses the pydantic data converter only, with no payload codec (`apps/harness/src/harness/temporal/client.py:55-72`). Run history in Temporal therefore holds PHI in clear text: trigger payloads, transcripts and generated notes.

TASK-1038 reduces the amount (claim-check above 20 KB, no duplicated run payload). It does not encrypt what remains.

## 2. Questions for the design (to be answered before planning)

1. Key management: a Vault Transit key per tenant or one platform key, and rotation without breaking replay.
2. Codec server for the Temporal UI (decrypt for authorised operators only).
3. Performance budget per activity payload.
4. Migration of in-flight histories (they stay readable with the old converter).

## 3. Change History

| Date | Change |
|---|---|
| 2026-10-04 | Ticket raised (TASK-1036 R-7 / OD-27). Pending a design. |
