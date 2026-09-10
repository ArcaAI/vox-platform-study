// TASK-950 — auto-provisioning policy for a context-schema user identity.
//
// ## What these three keys govern
//
// A tenant admin may mark ONE field of a `ConsultationContextSchema` version as the
// **user identity** field (plan D-1). When a service-account request arrives carrying that
// field, `ContextUserIdentityService.resolveOrProvision` maps its value to
// `UserProfile.staffId` and either REUSES the tenant user that already carries it or
// PROVISIONS one. These keys are the policy behind that second branch: whether it may happen
// at all, and which role and department the new user is given.
//
// ## Why this is CONFIGURATION, not schema content (plan D-9)
//
// `00-project-context.md` §"Content is cloned; configuration cascades" draws the line, and a
// schema version falls on the CONTENT side: it is cloned from the SYSTEM reference set into
// every tenant at tenant creation and is thereafter tenant-owned. A role id or a department id
// therefore CANNOT ride inside it — the cloned copy would carry the SYSTEM tenant's ids into
// every tenant, naming rows that tenant does not own. Role and department are per-tenant
// CONFIGURATION, so they resolve on the ordinary **tenant → SYSTEM** cascade
// (`09-infrastructure-devops.md` §Tenant-first resolution): the tenant's row wins, the SYSTEM
// row is the platform fallback for a tenant with no opinion, and "Global" (`50000000-…`) never
// appears in that walk.
//
// ## Why `tier: 'global-kv'` and not `db-config` (deviation from D-9's wording)
//
// The plan's D-9 prose says "three `db-config` descriptors", but its OWN Wave-0 step (W0-c)
// seeds the SYSTEM rows into `seed/11-global-setting.ts` — i.e. into `GlobalSetting`, which is
// the `global-kv` backing store. `db-config` would break all three of the things these keys
// have to do, and each failure was verified against the code on `dev-2.2`:
//
//   1. READ. `EffectiveSettingsService.resolveEffective` dispatches `db-config` per key FAMILY,
//      and the only family with a lane is platform storage (`PLATFORM_STORAGE_KEYS`). Any other
//      `db-config` key falls through to
//      `throw new ArgumentInvalidException("No effective resolver is registered for setting …")`
//      — so every consultation open / agent invocation / workflow run carrying an identity
//      field would 400 on the FIRST resolve, before provisioning was ever reached.
//   2. WRITE. `SettingsRegistryWriteService` refuses anything but `global-kv`
//      ("Tier 'db-config' is not writable through the registry lane"), so no tenant admin
//      could ever set the tenant half of the cascade these keys exist to provide.
//   3. SEED. A `GlobalSetting` row IS the `global-kv` value. Seeding one for a `db-config`
//      descriptor writes a row nothing reads.
//
// `global-kv` delivers exactly the semantics D-9 asks for: `TenantSettingsService.resolve`
// walks tenant override → SYSTEM row → descriptor default and reports which tier answered. It
// is also the tier the sibling per-tenant rollout gates already use
// (`feature-availability.descriptors.ts`, `maxScope: 'tenant'`).

import { SettingDescriptor } from '../registry.types';

/** Server-side taxonomy bucket for the auto-provisioning policy. */
export const USER_IDENTITY_CATEGORY = 'User Identity';

/** May HOPE create a tenant user for an unrecognised staff id? */
export const IDENTITY_AUTO_PROVISION_ENABLED_KEY = 'identity.autoProvision.enabled';
/** The `Role` a provisioned user is assigned in the tenant. */
export const IDENTITY_AUTO_PROVISION_ROLE_ID_KEY = 'identity.autoProvision.roleId';
/** The `Department` a provisioned user joins when the request names none. */
export const IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY = 'identity.autoProvision.departmentId';

/**
 * The 8-4-4-4-12 hyphenated hex id grammar, matching `PLATFORM_ID_PATTERN` in
 * `open-consultation.request.ts`. Deliberately NOT a UUID-VERSION check: HOPE mints UUIDv7 ids,
 * but the seeded SYSTEM rows use hand-written reserved prefixes (the `DOCTOR` role is
 * `00000000-0000-0000-0000-000000000010`), which no version-aware validator accepts. Refusing
 * free text at the write edge is the whole job here; whether the id NAMES a row is a question
 * only the resolver, holding a tenant, can answer.
 */
const PLATFORM_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Shared `validate` for the two id-valued keys — one implementation, so the two cannot drift. */
function requirePlatformId(label: string): (value: unknown) => string | void {
  return (value: unknown) => {
    if (typeof value !== 'string' || !PLATFORM_ID_PATTERN.test(value)) {
      return `${label} must be a 36-character hyphenated hex id (8-4-4-4-12), e.g. 00000000-0000-0000-0000-000000000010.`;
    }
  };
}

export const USER_IDENTITY_SETTINGS: SettingDescriptor[] = [
  {
    key: IDENTITY_AUTO_PROVISION_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    // A tenant may switch its own auto-provisioning off without a platform admin, and the
    // SYSTEM row is the platform default every silent tenant inherits.
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // A gate, not a kill-switch: `killSwitch: true` would bind it to the "must default OFF"
    // governance invariant, and the owner's answer (plan OD-3) is ON — the requirement says
    // HOPE "will create a user".
    failMode: 'open-to-default',
    category: USER_IDENTITY_CATEGORY,
    label: 'Auto-provision users from a context-schema identity field',
    description:
      'When a service-account request carries the schema-declared user-identity field and no tenant user holds that staff id, create one (User + UserProfile + role assignment + department membership, in one transaction). Off, an unrecognised staff id is refused with 404 `USER_IDENTITY_UNKNOWN` and nothing is written — the integrator must onboard the clinician first. This gate is consulted only AFTER the lookup misses, so turning it off never affects a staff id that already resolves. The plan seat quota (`maxUsers`) applies either way.',
    default: true,
  },
  {
    key: IDENTITY_AUTO_PROVISION_ROLE_ID_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // SELECTION, so fail-closed with NO code default: an unresolved role must raise, never
    // silently become "whatever the platform happened to ship". Substituting a default here
    // would grant a provisioned clinician a set of abilities nobody chose. The platform value
    // is a SEEDED SYSTEM row (the `DOCTOR` role), not a literal in this file — a code default
    // would make the seed unobservable and re-hardcode the selection the seed exists to own.
    failMode: 'closed',
    category: USER_IDENTITY_CATEGORY,
    label: 'Role for auto-provisioned users',
    description:
      "The `Role` assigned to a user provisioned from a context-schema identity field. The platform default is the seeded SYSTEM `DOCTOR` role, which carries the `create:Consultation` ability `assertNamedClinicianMayOwnConsultation` requires — a provisioned clinician that cannot own a consultation is useless. A tenant may point this at its own cloned role. `SUPER_ADMIN` is REFUSED at provisioning time (403) whatever this says, mirroring the identity-provider JIT guard: a machine request must never be able to mint a platform administrator. Unresolved is an error, never a substituted default.",
    validate: requirePlatformId('identity.autoProvision.roleId'),
  },
  {
    key: IDENTITY_AUTO_PROVISION_DEPARTMENT_ID_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // Fail-closed, and in practice tenant-only: a department id is a tenant-owned row, so a
    // SYSTEM value would name a department no tenant owns. Hence no code default either — see
    // the description.
    failMode: 'closed',
    category: USER_IDENTITY_CATEGORY,
    label: 'Fallback department for auto-provisioned users',
    description:
      "The `Department` a provisioned user joins when the request itself names none (the agent-invocation and workflow-run planes often do not). Resolution order is request `departmentId` → this setting → refuse with 400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`. Failing closed is deliberate (plan OD-8): `assertUserBelongsToTenant` requires BOTH an enabled role assignment and an enabled department membership, so a user created without a department is an account that cannot log in and 404s the moment it is named as a clinician — a silent defect discovered much later. There is no platform default: a department id is a tenant-owned row, so a SYSTEM value would name a department no tenant owns. Set it per tenant.",
    validate: requirePlatformId('identity.autoProvision.departmentId'),
  },
];
