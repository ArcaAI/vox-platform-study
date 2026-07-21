# Findings Register — TASK-539 Continuous Quality Program

Living document. Every confirmed finding, its status, and the ticket that owns it. Updated each assessment cycle. Seeded 2026-07-21 from the Phase-0 baseline (workflow `wf_e0632a48-a69`) and the TASK-536 Wave-1 inventory.

Status values: `open` · `owned` (ticket exists) · `fixed` · `accepted-risk` · `superseded`.

| ID | Finding | Severity | Dimension | Status | Owner |
|---|---|---|---|---|---|
| F-001 | `isTokenRevoked()` always returned `false` — token revocation not implemented (`auth.service.ts`) | P0 | Security | **fixed** (2026-07-21, runtime-verified per ticket; re-verify in cycle-1 e2e) | TASK-541 |
| F-002 | No persisted HIPAA-compliance audit trail for authentication events | P0 | Security | **fixed** (2026-07-21, with TASK-541; re-verify in cycle-1 e2e) | TASK-541 |
| F-003 | Username-enumeration oracle: `findFirst` threw instead of returning null on unknown user (found during TASK-541) | P1 | Security | fixed (TASK-541) | TASK-541 |
| F-004 | Config plane (TASK-524/525/526) never runtime-verified: migration not applied to test DB, no Vault-live round-trip for `encryptedApiKey`, no live-DB boot, BYO→SMR path unexercised | P0 | Correctness | open | cycle-1 §2 |
| F-005 | ~65 authored API e2e specs never executed; cross-tenant contracts for all new admin surfaces unproven live | P0 | Test posture | **GREEN 2026-07-21**: after F-022/023 clearance, full suite 669 pass / 23 skip / 1 isolated-rerun-green throttle flake | TASK-534 / cycle-1 §1 |
| F-022 | First e2e run: 22 failures → triaged 2026-07-21 into 9 groups: **15 product defects / 7 test bugs**. **FIXED 2026-07-21** (G1/G3/G4/G5/G6/G9 + G7/G8 spec hygiene + F-024): re-run of the 7 affected specs 105 pass / 2 fail (the 2 = G2/F-023); units 6,677 (applications) + 2,396 (api) green; build green. G9 note: clone gate changed to `@CanCreate('Role')` — owner-reversible to global-only | P0 | Correctness | fixed (pending G2 tail) | TASK-534 |
| F-023 | **`If-Match: "0"` create-lane collision (G2, OWNER DECISION)**: `expectedVersion.decorator.ts` rejects `"0"` with 400 (TASK-302 house rule) but TASK-506/526 froze `"0"`-creates as the convention and the shipped console sends it (`FIRST_EDIT_ETAG`) — first-edit writes on `@RequiresIfMatch` routes are impossible over HTTP in production | P0 | Correctness | **fixed 2026-07-21** — owner decided: accept `"0"` as create-intent; decorator relaxed (RED→GREEN, 28 tests), stale-`"0"`-vs-existing → 412 covered; console first-edit path restored | TASK-506/526 vs TASK-302 |
| F-024 | `fetchBySlug`/`fetchById` return 200-with-empty-body on null instead of 404 (audio-pipeline + ai-model admin controllers) | P2 | Correctness | fixed 2026-07-21 (404 on null in both admin controllers) | TASK-528/531 |
| F-006 | Harness D-22 segment→citation chain never proven on a live streamed consultation | P0 | Correctness | open | cycle-1 §3 |
| F-007 | Settings cross-instance convergence eventual-only: 45s cron; `ResourceUpdated` broadcast has zero subscribers (`settings-registry-write.service.ts:117`) | P1 | Correctness | open (quick win: add sys-event subscriber) | cycle-1 QW |
| F-008 | 3 of 6 `agentic.context` knobs resolve but govern nothing until TASK-533-B3/B4 land | P1 | Completeness | open | TASK-533 |
| F-009 | Admin-console screens built under design waivers with no headed-browser pass (TASK-526 explicitly; 528 hub never driven authenticated) | P1 | Completeness | open | cycle-1 §4 |
| F-010 | stt-v2 segment producers contract-locked but never produced rows live; S3 enum migration applied to dev DB only | P1 | Correctness | open | cycle-1 §3/§1 pre-flight |
| F-011 | OD-2 safety-toggle lock: blast-radius query ran on dev only; production run + tenant comms outstanding | P1 | Security/Ops | open (owner) | cycle-1 §5 |
| F-012 | Retention/VRAM unverified on real hardware: pynvml extra omitted; LM Studio `ttl` + Ollama `keep_alive` live behavior unproven; OD-5 default unsigned | P1 | Performance | open | cycle-1 §6 |
| F-013 | Clinical eval gate `allow_failure: true`; golden set 18 synthetic vs spec N≥132; SME unassigned | P1 | Correctness (clinical) | open (owner/process) | cycle-1 §7 |
| F-014 | `_make_llama_logit_fn` (llama_cpp `_internals`, 2 mirrored sites) zero real coverage; breaks on dependency upgrade | P2 | Test posture | open | cycle-2 candidate |
| F-015 | Dormant-feature inventory (533-C) shipped but OFF, gated on hardware-tier decision | P2 | Completeness | open (owner) | dedicated cycle |
| F-016 | 827 bare `eslint-disable` comments without justification | P2 | Quality | owned | TASK-540 |
| F-017 | TASK-499 SAML: real signed-assertion tampered/expired/replayed/XSW matrix never built | P1 | Security | open | cycle-2 |
| F-018 | NUL byte at `live-documentation.service.ts:1424` — ripgrep silently skips the file | P2 | Quality | open (quick win) | cycle-1 QW |
| F-019 | Domain drift gates (`gen:entity:check`/`gen:factory:check`) previously RED at HEAD; believed repaired by 533-A but never re-run | P2 | Quality | **fixed/verified 2026-07-21** — both checks green with "schema coverage OK" (ran during TASK-536 batch 2) | cycle-1 QW |
| F-020 | `docs/research/security/*` corpus deleted in checkpoint `c6c44de2` (owner-directed commit-everything). Recoverable from git history | P3 | Process | accepted-risk (recorded) | — |
| F-021 | Pre-existing broken suites discovered during TASK-541 (2, per its README) | P2 | Test posture | open — enumerate from TASK-541 README in cycle 1 | cycle-1 §1 |

Cross-references: TASK-538's SOTA gap backlog merges here when Wave 4 completes; TASK-536's TODO harvest adds completion findings as Wave-2 batches land.
