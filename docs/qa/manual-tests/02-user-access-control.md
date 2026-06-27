# Area B — User & Access Control Management (per tenant) (Manual E2E)

> Read [`README.md`](./README.md) first for environment prerequisites (§4), personas/accounts (§5), cross-cutting principles (§6), status legend (§3.3), and the confirmation matrix (§7).
>
> **Scope:** management of users and their access **within a tenant**. For global tenant selection (which tenant these operations apply to), see **MT-07**.
> **Primary personas:** `tenant_admin` / `arcaai_admin` (per-tenant admin). `super_admin` acts on a **selected working tenant** (MT-07).
> **Requirement basis:** business requirements only (User Stories, Access Control, Project Brief).

**Suite index:** UAC-01 Create · UAC-02 Update · UAC-03 Role Management · UAC-04 Activate/Deactivate · UAC-05 Destroy

> **Global dependency for Area B:** the operating tenant must be established first — `super_admin` selects a working tenant (MT-07) or you sign in as a tenant-scoped admin (`tenant_admin` / `arcaai_admin`). Every case below operates **within that one tenant** and must respect tenant isolation (X1).

---

## UAC-01 — Create User

**Requirement.** An admin can create new user accounts with a **username and password** so doctors/staff can access the system. New users belong to the admin's (working) tenant. *(Source: US 26; tenant scoping AC/US 91.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________

**Roles under test:** `TENANT_ADMIN` (positive, own tenant); `super_admin` on a selected tenant; `DOCTOR`/`NURSE` (negative).

**Prerequisites**
- Operating tenant established (sign in as `tenant_admin`, or `super_admin` + MT-07 working tenant).
- A unique username ready (e.g., `qa_user_01`).

**Preconditions / Conditions**
- Know an existing username (e.g., `doctor`) to test uniqueness.
- Know the tenant's password policy (length/complexity) if one is stated.

**Dependencies**
- MT-07 (working tenant) for `super_admin`. Feeds UAC-02/03/04/05 (uses the created user as a target).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| UAC-01.1 | Create with valid data | 1) Open Create User<br>2) Enter username `qa_user_01` + password (+ any required profile)<br>3) Submit | Success; user appears in the tenant's user list | Positive | ☐ | |
| UAC-01.2 | New user can sign in | 1) Sign out<br>2) Sign in as `qa_user_01` with the set password | Login succeeds; user lands in their permitted area | Positive | ☐ | |
| UAC-01.3 | Required-field validation | 1) Submit with empty username and/or password | Blocked with clear inline messages; nothing created | Validation | ☐ | |
| UAC-01.4 | Duplicate username rejected | 1) Create with username `doctor` (existing in tenant) | Rejected as duplicate; no user created | Validation/Negative | ☐ | Confirm uniqueness scope (per-tenant vs global) |
| UAC-01.5 | Password policy enforced | 1) Enter a weak/short password | Rejected per stated policy with guidance | Validation | ☐ | If no policy, mark NA |
| UAC-01.6 | New user scoped to tenant | 1) Create `qa_user_01` in tenant A<br>2) Switch to tenant B (MT-07) and view users | `qa_user_01` is **not** present in tenant B (X1) | Isolation | ☐ | |
| UAC-01.7 | Creation audited | 1) Create a user<br>2) Open audit logs | CREATE User entry with actor, tenant, timestamp (X6) | Audit | ☐ | |
| UAC-01.8 | Non-admin cannot create | 1) As `doctor`, attempt to create a user | Denied/unavailable | RBAC | ☐ | |
| UAC-01.9 | Temp secret handling | 1) If a temporary password/secret is generated/displayed | It is shown clearly once and handled securely (no plaintext persisted/exposed later) (X8) | Edge/Security | ☐ | If not applicable, NA |

---

## UAC-02 — Update User

**Requirement.** An admin can update a user's details (profile fields; e.g., assign a **primary department**). *(Source: US 27; US 111 department assignment.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________

**Roles under test:** `TENANT_ADMIN`/`super_admin`(on tenant) positive; `DOCTOR` negative.

**Prerequisites**
- A target user exists (`qa_user_01` from UAC-01, or seeded `doctor`).
- Departments exist in the tenant (seed provides 15, e.g., Cardiology, Surgery).

**Preconditions / Conditions**
- Note current values before editing to verify before/after.

**Dependencies**
- UAC-01 (target user); MT-07 (working tenant).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| UAC-02.1 | Edit profile fields | 1) Open `qa_user_01`<br>2) Change display name / email / other profile fields<br>3) Save | Success; changes persist after refresh | Positive | ☐ | |
| UAC-02.2 | Assign primary department | 1) Set primary department (e.g., Cardiology)<br>2) Save | Department association persists for the user | Positive | ☐ | US 111; if not present, NA |
| UAC-02.3 | Validation on update | 1) Enter invalid email/format and Save | Rejected with message; previous value retained | Validation | ☐ | |
| UAC-02.4 | Cross-tenant edit blocked | 1) As `arcaai_admin`, attempt to open/edit a Default-tenant user | User not found/visible; cannot edit (X1, 404-over-403) | Isolation | ☐ | |
| UAC-02.5 | Non-admin cannot edit others | 1) As `doctor`, attempt to edit another user | Denied | RBAC | ☐ | |
| UAC-02.6 | Update audited (before/after) | 1) Edit a field<br>2) Open audit logs | UPDATE entry with previous + new values (X6) | Audit | ☐ | |

---

## UAC-03 — Role & Permission Management

**Requirement.** An admin can manage access: assign roles to users; create **custom roles** (name + description) that **inherit a system role and cannot exceed the parent**; create **CASL policies** (action, subject, conditions, fields); attach policies to roles with **priority ordering**; define **hierarchical** parent/child roles; **system roles are protected**; role assignments are **tenant-scoped**; and **no privilege escalation** is possible. Role/policy changes are audited. *(Source: US 27, 36, 37, 38, 39, 40, 41, 42; AC.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________

**Roles under test:** `TENANT_ADMIN`/`super_admin`(on tenant) positive; `DEPARTMENT_HEAD` (delegated); `DOCTOR` negative.

**Prerequisites**
- Operating tenant established (MT-07 or tenant-scoped admin).
- A target user (`qa_user_01`); knowledge of seeded roles (README §5).

**Preconditions / Conditions**
- Effective-permission changes may be cached briefly (RBAC cache ~5 min); to verify effect, re-login as / impersonate the target user or wait for invalidation.

**Dependencies**
- UAC-01 (target user); MT-07 (working tenant). Pairs with UAC-04/05 for full lifecycle.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| UAC-03.1 | Assign a system role | 1) Open `qa_user_01`<br>2) Assign role `DOCTOR`<br>3) Save | Role assigned; reflected on user (role badge) | Positive | ☐ | US 27 |
| UAC-03.2 | Role badges in user list | 1) View the user list | Each user shows their role(s) as badges; paginated list is consistent | Positive | ☐ | US 28 |
| UAC-03.3 | Effect of role change | 1) After assigning `DOCTOR`, impersonate or re-login as `qa_user_01`<br>2) Attempt a doctor-only action | The user now has the role's permissions (and not more) | Positive | ☐ | |
| UAC-03.4 | Remove a role | 1) Remove `DOCTOR` from `qa_user_01`<br>2) Verify effect | Role removed; corresponding access revoked after cache refresh | Positive | ☐ | |
| UAC-03.5 | Create custom role | 1) Create role `QA_VIEWER` with description, inheriting a system parent (e.g., `NURSE`) | Role created and listed; marked non-system | Positive | ☐ | US 36 |
| UAC-03.6 | Custom role cannot exceed parent | 1) Attempt to give `QA_VIEWER` permissions beyond its parent (`NURSE`) | Rejected/clamped — child cannot exceed parent (X3) | RBAC/Negative | ☐ | AC |
| UAC-03.7 | Create a policy | 1) Create a CASL policy (action, subject, conditions, optional fields) | Policy created; validates structurally | Positive | ☐ | US 37 |
| UAC-03.8 | Attach policy with priority | 1) Attach the policy to a role with a priority/order | Attachment persists; ordering is respected in resolution | Positive | ☐ | US 38 |
| UAC-03.9 | Hierarchical inheritance | 1) Inspect a child role (e.g., `DEPARTMENT_HEAD` → `DOCTOR`) | Child inherits parent permissions plus its own | Positive | ☐ | US 39 |
| UAC-03.10 | System role protection | 1) Attempt to edit or delete a system role (e.g., `SUPER_ADMIN`, `DOCTOR`) | Blocked/disabled with explanation (X4) | Negative | ☐ | US 40 |
| UAC-03.11 | Tenant-scoped assignment | 1) Assign a role within tenant A<br>2) Switch to tenant B and inspect the user/role | Assignment applies only in the intended tenant; no leakage (X1) | Isolation | ☐ | US 41 |
| UAC-03.12 | No privilege escalation (self) | 1) As `tenant_admin`, attempt to assign `SUPER_ADMIN` (above own level) to any user | Rejected — cannot grant a role above own level (X3) | RBAC/Negative | ☐ | |
| UAC-03.13 | No privilege escalation (cross-tenant) | 1) As `tenant_admin`, attempt to assign a global/cross-tenant role | Rejected/unavailable | RBAC/Negative | ☐ | |
| UAC-03.14 | Delegated assignment | 1) As `department_head` (has delegated RBAC), assign a permitted role within scope | Allowed only within delegated scope; out-of-scope assignment denied | RBAC | ☐ | Confirm delegation surface |
| UAC-03.15 | Non-admin cannot manage roles | 1) As `doctor`, attempt to open role/policy management | Denied/unavailable | RBAC | ☐ | |
| UAC-03.16 | RBAC changes audited | 1) Assign/remove a role; change a policy<br>2) Open audit logs | AUTHORIZATION/RESOURCE audit entries with actor, target, before/after (X6) | Audit | ☐ | US 42 |

---

## UAC-04 — Activate / Deactivate User

**Requirement.** An admin can deactivate (disable) and reactivate a user's access — a reversible status change, distinct from destroy. Deactivation requires confirmation. *(Source: US 29 — deactivation via deliberate action; AC — active/disabled lifecycle; X7.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________

**Roles under test:** `TENANT_ADMIN`/`super_admin`(on tenant) positive; `DOCTOR` negative.

**Prerequisites**
- A target user that is safe to disable (`qa_user_01`).

**Preconditions / Conditions**
- Have the target user's credentials to verify login is blocked when deactivated.
- Do not deactivate the only admin of a tenant or your own session account.

**Dependencies**
- UAC-01 (target). Distinct from UAC-05 (destroy): deactivate must be **reversible**.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| UAC-04.1 | Deactivate requires confirmation | 1) Choose Deactivate on `qa_user_01` | Confirmation prompt appears; no change until confirmed (X7) | Positive | ☐ | |
| UAC-04.2 | Deactivate succeeds | 1) Confirm deactivation | User shown as Inactive/Disabled; status reflected in list | Positive | ☐ | |
| UAC-04.3 | Deactivated user cannot log in | 1) Sign out<br>2) Attempt login as `qa_user_01` | Login denied; existing sessions/tokens cease to grant access | Negative | ☐ | |
| UAC-04.4 | Reactivate restores access | 1) Reactivate `qa_user_01`<br>2) Attempt login | User active again; login succeeds | Positive | ☐ | Reversibility |
| UAC-04.5 | Cross-tenant deactivate blocked | 1) As `arcaai_admin`, attempt to deactivate a Default-tenant user | Not visible/permitted (X1) | Isolation | ☐ | |
| UAC-04.6 | Self/last-admin safeguard | 1) Attempt to deactivate your own account or the tenant's last admin | Blocked or clearly warned to prevent lockout | Edge | ☐ | Confirm expected safeguard |
| UAC-04.7 | Non-admin cannot deactivate | 1) As `doctor`, attempt to deactivate a user | Denied | RBAC | ☐ | |
| UAC-04.8 | Status change audited | 1) Deactivate then reactivate<br>2) Open audit logs | UPDATE entries capturing status transitions, actor, timestamp (X6) | Audit | ☐ | |

---

## UAC-05 — Destroy (Archive) User

**Requirement.** An admin can remove a user via a **confirmation dialog**. Per platform principle, removal is a **soft-delete/archive** ("users cannot be deleted, only archived"), not a hard delete. *(Source: US 29; AC — X2, X7.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________

**Roles under test:** `TENANT_ADMIN`/`super_admin`(on tenant) positive; `DOCTOR` negative.

**Prerequisites**
- A disposable target user (create a fresh `qa_user_del` via UAC-01).

**Preconditions / Conditions**
- ⚠️ Only archive disposable QA users — never seeded/real accounts you still need.

**Dependencies**
- UAC-01 (creates target). Compare against UAC-04 to confirm destroy ≠ deactivate.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| UAC-05.1 | Confirmation dialog required | 1) Choose Delete on `qa_user_del` | A confirmation dialog appears; nothing happens until confirmed (X7) | Positive | ☐ | US 29 |
| UAC-05.2 | Delete (archive) succeeds | 1) Confirm | User removed from the active list; success message | Positive | ☐ | |
| UAC-05.3 | Soft-delete, not hard-delete | 1) Verify the record persists in archived state (audit/Studio), not physically removed | Record archived, retained for audit/compliance (X2) | Audit/Isolation | ☐ | |
| UAC-05.4 | Archived user cannot log in | 1) Attempt login as `qa_user_del` | Login denied | Negative | ☐ | |
| UAC-05.5 | Protected/self account | 1) Attempt to delete your own account or a protected admin | Blocked/warned to prevent lockout | Edge | ☐ | Confirm safeguard |
| UAC-05.6 | Cross-tenant delete blocked | 1) As `arcaai_admin`, attempt to delete a Default-tenant user | Not visible/permitted (X1) | Isolation | ☐ | |
| UAC-05.7 | Non-admin cannot delete | 1) As `doctor`, attempt to delete a user | Denied | RBAC | ☐ | |
| UAC-05.8 | Deletion audited | 1) Delete a user<br>2) Open audit logs | DELETE/ARCHIVE entry with actor, tenant, timestamp (X6) | Audit | ☐ | |
| UAC-05.9 | Cancel aborts | 1) Open confirm dialog, Cancel | User remains active and unchanged | Edge | ☐ | |
