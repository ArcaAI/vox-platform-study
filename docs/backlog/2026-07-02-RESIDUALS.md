# Parked Residuals — 2026-07-02

Two items deliberately parked at the close of the TASK-386→402 program. Revisit later.

## 1. Audit-payload field redaction sweep

- **Source:** TASK-402 §5 flags (`docs/archive/TASK-402-Password-Hash-And-Settings-Fixes/README.md`).
- **Context:** TASK-402 stopped plaintext passwords from entering the SysEvent pipeline — user `ResourceCreated`/`ResourceUpdated` audit payloads now carry only the bcrypt hash. Ideally password (and similar secret) fields are **redacted entirely** from audit payloads rather than carried as hashes.
- **Scope when picked up:**
  1. Field-level redaction (denylist: `password`, `tokenHash`, `encryptedValue`, etc.) applied where SysEvent payloads are built before enqueue.
  2. Historical scrub: dev/test `AuditLog` rows written **before** the TASK-402 fix may still contain plaintext passwords in `metadata`. UPDATE-only scrub of matching payload fields (no row deletion). Count first, then scrub.
- **Effort:** S–M. No schema changes expected.

## 2. MS-Graph live email credentials

- **Source:** TASK-400 (`docs/archive/TASK-400-Password-Security-Hardening/README.md`).
- **Context:** The public forgot-password flow ships with a fully implemented MS-Graph mail transport, but **no credentials exist in any env file**, so non-prod uses the dev JSONL outbox and prod would WARN no-op.
- **To activate real delivery**, set:
  - `MSGRAPH_CLIENT_ID`
  - `MSGRAPH_CLIENT_SECRET`
  - `MSGRAPH_TENANT_ID`
  - `MSGRAPH_SENDER`
  - `PASSWORD_RESET_LINK_BASE_URL` (absolute completion links)
- **Then:** verify one real send to a safe test address and record the evidence in the TASK-400 ticket.
- **Effort:** S (config + one verification) once credentials are provisioned.

---
Status: **Parked** — not scheduled. Pick up via a small dedicated worker each.
