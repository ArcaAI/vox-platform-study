# `ALL-3.0.0` — SUPERSEDED, never tagged

**This train was never cut.** It was drafted 2026-08-18 against the API-plane hardening slice
(TASK-754…768) and sat as an untagged draft while the work it described shipped on `dev-2.2` and
was released under a different tag.

**Its content now lives in [`ALL-2.2.0.md`](./ALL-2.2.0.md)** — the note for the train that was
actually tagged (2026-09-11). Read that. Specifically:

| Was here | Now |
|---|---|
| §1 admin plane is JWT-only | [`ALL-2.2.0.md`](./ALL-2.2.0.md) §3.1 |
| §2 business-plane URI normalization | §3.3 |
| §3 downstream-unreachable → 503/502 | §3.4 |
| §4 service accounts | §4 (amended — they now reach the realtime consultation plane) |
| §5 security fixes | §5 |
| §6 bootstrap admin provisioning | §6 |
| Upgrade checklist | §9 |

This file is kept as a stub rather than deleted because other documents link to it by name.
**Do not tag `ALL-3.0.0`** — `ALL-2.2.0` is the released train, and a later tag must be
`ALL-2.3.0` or above.

*Retired by TASK-953, on the owner's decision to consolidate the two untagged drafts into the
tagged train's note.*
