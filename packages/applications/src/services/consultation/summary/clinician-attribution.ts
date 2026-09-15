/**
 * TASK-972 Lane 1 — WHO a clinical write is ATTRIBUTED to, and WHICH credential submitted it.
 *
 * ## The defect
 *
 * `approveSummary` stamped `approvedBy = this.requestUserId` and threw when it was absent, so a
 * service account could not sign a note even once the gateway scope existed — and had it been
 * able to, the MACHINE would have been recorded as the clinician who attested a clinical
 * document. Both halves are wrong in opposite directions: an integration must be able to submit
 * a clinician's sign-off, and it must never BE the clinician.
 *
 * ## The rule, which no route decorator can state
 *
 * A decorator expresses `action + subject` for the CALLER. It cannot express "who may this
 * caller act FOR", because the answer depends on the CREDENTIAL CLASS and on a role the caller
 * holds in THIS tenant. So the gate is imperative, and it is TASK-974's `resolveIngestClinician`
 * applied verbatim to the finish half of the consultation plane:
 *
 * | Caller | `clinicianUserId` |
 * |---|---|
 * | human JWT | omit ⇒ self; may name another ONLY while holding `SUPER_ADMIN` / `TENANT_ADMIN` (else 400) |
 * | service account | REQUIRED (400 otherwise); may name any clinician of its working tenant |
 * | API key | only the human it is bound to, UNLESS that human holds `SUPER_ADMIN` / `TENANT_ADMIN` — a credential never exceeds its human |
 * | any | a clinician outside the tenant ⇒ 404 ({@link assertAttributedClinicianInTenant}) |
 *
 * A clinician naming another clinician is **400, not 403**: the request is refused on WHO it
 * names, and there is no id to protect — they are being told about a rule, not about a row. A
 * clinician of ANOTHER TENANT is the opposite case and stays the house 404-over-403 posture.
 *
 * ## Why the role read is tenant-scoped
 *
 * A user who administers tenant B is nobody in tenant A, so the third-party admin check reads
 * `UserRoleAssignment` rows FOR THIS TENANT and never a cross-tenant role list. The one
 * exception is a `SUPER_ADMIN` marked on the CALLER's own authenticated session: that is the
 * house-wide way a platform administrator is recognised (`tenant-guards.isSuperAdmin` reads the
 * same field), it is the caller's own identity rather than a third party's, and a platform
 * admin holds no role assignment in a customer tenant by design.
 *
 * ## Why this is a module of free functions and not a service
 *
 * Two services need it — `SummaryService` (update + approve) and `ConsultationService` (close) —
 * and they are constructed positionally in a long tail of unit fixtures. A new injectable would
 * have to be threaded through both graphs and every fixture; a function taking its collaborators
 * explicitly is the same rule in one place with no DI surface at all.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import type { UserDepartmentRepository, UserRepository, UserRoleAssignmentRepository } from '@arcaai/domains';
import { assertUserBelongsToTenant } from '../../../common/tenant-guards';

/** The three credential classes that can reach a clinical write. */
export type ClinicalCredentialClass = 'jwt' | 'api-key' | 'service-account';

/**
 * WHICH CREDENTIAL submitted this write — resolved by the controller, never inferred from a body.
 *
 * Shaped like `DnaJobRequestedBy` (TASK-974) on purpose: the controller that builds one can
 * build the other, and a reader who has met that type has met this one.
 */
export interface ClinicalCaller {
  credentialClass: ClinicalCredentialClass;
  /** The CREDENTIAL's id — a `ServiceAccount.id`, an `ApiKey.id`, or the human's own user id. */
  principalId: string;
  /**
   * The human an API key is bound to (`ApiKey.userId`), or `null` for an unbound key.
   *
   * Carried ONLY for the API-key class and only as an authorization INPUT: scopes bind the
   * credential while abilities bind the bound human, and the two compose as AND — so a key must
   * not be able to sign for a clinician its own human could not.
   */
  boundUserId?: string | null;
}

/** The roles that let a caller act for SOMEONE ELSE. */
export const CLINICIAN_ATTRIBUTION_ADMIN_ROLES: readonly string[] = ['SUPER_ADMIN', 'TENANT_ADMIN'];

/** Error codes the gateway surfaces verbatim, so an integrator can branch on them. */
export const CLINICIAN_REQUIRED_CODE = 'CLINICIAN_REQUIRED';
export const CLINICIAN_NOT_ALLOWED_CODE = 'CLINICIAN_NOT_ALLOWED';

/** The CALLER's own session, as much of it as this rule reads. */
export interface AttributionSession {
  id?: string | null;
  roles?: string[] | null;
}

/** Reads the role NAMES a user holds IN ONE TENANT. Rejecting is a refusal, never a pass. */
export type TenantRoleReader = (userId: string, tenantId: string) => Promise<string[]>;

export interface ResolveAttributedClinicianInput {
  /** `clinicianUserId` as the caller sent it. */
  named: string | undefined | null;
  /** Absent ⇒ a human JWT. Every pre-existing call site therefore behaves exactly as before. */
  caller: ClinicalCaller | undefined;
  tenantId: string;
  requestUser: AttributionSession | null | undefined;
  readTenantRoles: TenantRoleReader;
}

/**
 * The clinician this write is attributed to, or a `BadRequestException` naming the rule.
 *
 * Does NOT assert tenant membership — that is {@link assertAttributedClinicianInTenant}, kept
 * separate because it is a 404 (a row-existence answer) while everything here is a 400 (a rule
 * answer), and conflating the two is how an existence oracle gets built.
 */
export async function resolveAttributedClinician(input: ResolveAttributedClinicianInput): Promise<string> {
  const { named, tenantId, requestUser, readTenantRoles } = input;
  // An absent caller is a human JWT: the only callers that do not supply one are the in-process
  // and fixture call sites that predate this rule, and all of them act as a person.
  const caller: ClinicalCaller = input.caller ?? { credentialClass: 'jwt', principalId: requestUser?.id ?? '' };

  if (caller.credentialClass !== 'jwt') {
    if (!named) {
      throw new BadRequestException({
        code: CLINICIAN_REQUIRED_CODE,
        message:
          'A machine credential must name the clinician this note belongs to (`clinicianUserId`); it is never the clinician itself. ' +
          'A machine is recorded as the ACTOR beside them, never as the attesting clinician.',
      });
    }

    // A SERVICE ACCOUNT is the platform's machine identity, bound to a WORKING TENANT rather
    // than to a person (TASK-933), and acting for a whole tenant's clinicians is its remit. The
    // tenant boundary is still enforced by `assertAttributedClinicianInTenant` at the call site.
    if (caller.credentialClass === 'service-account') return named;

    // An API KEY is bound to a PERSON, and a credential can never exceed the human it belongs
    // to. The scope says the key may sign — it does not say WHOSE note.
    if (named === caller.boundUserId) return named;
    if (caller.boundUserId && (await holdsAttributionAdminRole(caller.boundUserId, tenantId, null, readTenantRoles))) return named;
    throw new BadRequestException({
      code: CLINICIAN_NOT_ALLOWED_CODE,
      message:
        'This API key may act only for the clinician it is bound to. A key bound to a tenant or super administrator may name any ' +
        'clinician of its tenant; mint the key against that principal, or submit under the clinician`s own credential.',
    });
  }

  const callerId = requestUser?.id;
  if (!callerId) {
    throw new BadRequestException('User ID is required');
  }
  if (!named || named === callerId) return callerId;

  if (await holdsAttributionAdminRole(callerId, tenantId, requestUser?.roles ?? null, readTenantRoles)) return named;
  throw new BadRequestException({
    code: CLINICIAN_NOT_ALLOWED_CODE,
    message: 'Only a tenant or super administrator may act on another clinician`s behalf. Omit `clinicianUserId` to act as yourself.',
  });
}

/**
 * Does this user hold an administrative role IN THIS TENANT?
 *
 * FAILS CLOSED in both directions: an unreadable role list is not an administrative one, and a
 * user with no assignment in this tenant is nobody in it. `sessionRoles` is consulted ONLY for
 * `SUPER_ADMIN` and only when it is the CALLER's own session — see the module header.
 */
async function holdsAttributionAdminRole(
  userId: string,
  tenantId: string,
  sessionRoles: string[] | null,
  readTenantRoles: TenantRoleReader,
): Promise<boolean> {
  if (sessionRoles?.includes('SUPER_ADMIN')) return true;
  try {
    const names = await readTenantRoles(userId, tenantId);
    return names.some((name) => CLINICIAN_ATTRIBUTION_ADMIN_ROLES.includes(name));
  } catch {
    return false;
  }
}

/** The repositories `assertUserBelongsToTenant` needs, each optional so a fixture can omit them. */
export interface MembershipRepositories {
  userRoleAssignmentRepository?: UserRoleAssignmentRepository;
  userDepartmentRepository?: UserDepartmentRepository;
  userRepository?: UserRepository;
}

/**
 * The named clinician must belong to the caller's tenant — 404, never 403 (the house posture,
 * and doubly right here because a clinical note is PHI).
 *
 * An UNWIRED membership graph is a 404 too, deliberately: a composition that cannot prove
 * membership must not attribute a clinical attestation on the strength of an unverified id.
 * Only the NAMED path reaches this, so every call site that acts as its own caller is unaffected.
 */
export async function assertAttributedClinicianInTenant(repos: MembershipRepositories, clinicianUserId: string, tenantId: string): Promise<void> {
  const { userRoleAssignmentRepository, userDepartmentRepository, userRepository } = repos;
  if (!userRoleAssignmentRepository || !userDepartmentRepository || !userRepository) {
    throw new NotFoundException('Resource not found');
  }
  await assertUserBelongsToTenant(userRoleAssignmentRepository, userDepartmentRepository, userRepository, clinicianUserId, tenantId);
}

/**
 * The tenant-scoped role reader backed by `UserRoleAssignment`, which eager-loads `Role` — so
 * the role NAMES come back with the assignments and no second read is needed.
 *
 * An unwired repository answers "no roles", which the resolver reads as "not an administrator".
 */
export function tenantRoleReaderFor(repository?: UserRoleAssignmentRepository): TenantRoleReader {
  return async (userId: string, tenantId: string) => {
    if (!repository) return [];
    const assignments = (await repository.findAll({
      where: { userId, tenantId, resourceStatus: ResourceStatusType.ENABLED },
    })) as Array<{ Roles?: Array<{ name: string }> | null }>;
    return assignments.flatMap((assignment) => (assignment.Roles ?? []).map((role) => role.name));
  };
}
