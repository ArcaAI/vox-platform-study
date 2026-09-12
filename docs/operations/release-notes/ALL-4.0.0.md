# `ALL-4.0.0` — SUPERSEDED placeholder, never tagged

**`ALL-4.0.0` was always a working name, not a version.** This file drafted the "R1" removal
release on 2026-09-07, while TASK-859 OD-2 ("name the removal-release tags") was open. It
described everything merged onto `dev-2.2` after the equally untagged `ALL-3.0.0` draft — work
that has since shipped under the tag that was actually cut.

**Its content now lives in [`ALL-2.2.0.md`](./ALL-2.2.0.md)** (tagged 2026-09-11). Specifically:

| Was here | Now |
|---|---|
| §1 what a tenant gets | [`ALL-2.2.0.md`](./ALL-2.2.0.md) §1 |
| §2 what a developer gets · §2a the end-to-end drive | §1–§2 |
| §3 breaking changes (typed prompt `variables`, content-is-cloned 503s, `includeTemplates`, the browser SDK's admin surface) | §3.2, §3.5, §3.6 |
| §4 removals | §7 |
| §5 migrations | §8 (recounted for the full `ALL-2.1.0`..`ALL-2.2.0` span: 40, not 28) |
| §6 upgrade checklist | §9 |
| §8 known gaps | §10 |

**What this means for the deprecation register.** The removals this file listed have LANDED and
ship in `ALL-2.2.0`, so "R1" is `ALL-2.2.0` for those. **`R2`–`R4` are still unnamed** — the rest
of TASK-859 OD-2 remains an open owner decision, and the register's `Remove in` cells for the R4
window still read as placeholders.

This file is kept as a stub rather than deleted because other documents link to it by name.

*Retired by TASK-953, on the owner's decision to consolidate the two untagged drafts into the
tagged train's note.*
