/**
 * Tenant isolation guards enforcing multi-tenancy hardening.
 *
 * Pure helpers that enforce tenant isolation on cross-aggregate writes
 * (Consultation -> Department, ContextItem -> Consultation, ApiKey -> User,
 * etc.). Throw `NotFoundException` on tenant mismatch — never
 * `ForbiddenException` — to avoid leaking the existence of a cross-tenant
 * resource. Mirrors the no-existence-leak rule already used in
 * `DepartmentService.update`, `PromptManagementService.assertOwnedByTenant`,
 * and `TenantBucketService`.
 *
 * NestJS exceptions (`@nestjs/common`) are used here to stay consistent with
 * those existing services (the spec's `@arcaai/exceptions.BadRequestException`
 * does not exist in this codebase; the existing tenant-leak callsites already
 * use `@nestjs/common.NotFoundException` / `BadRequestException`).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ResourceStatusType, type UserDepartmentRepository, type UserRepository, type UserRoleAssignmentRepository } from '@arcaai/domains';

/**
 * Platform-wide operator role, scoped above any single tenant — the ONLY
 * role with cross-tenant administrative rights. Mirrors
 * `services/tenant/constants.GLOBAL_ADMIN_ROLE` (kept local here so
 * `common/` does not import from `services/`). The former `SUPER_ADMIN`
 * role was consolidated into `GLOBAL_ADMIN` and retired.
 */
const GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN';

/**
 * Single source of truth for the set of roles that are cross-tenant
 * privileged ("elevated"). Both the pure `isSuperAdmin` predicate below and
 * the DB-layer `ClsTenantContextProvider.isSuperAdmin()` consume this set, so
 * a new elevated role is added in exactly one place. The set is exactly
 * `[GLOBAL_ADMIN]`.
 */
export const ELEVATED_ROLES: readonly string[] = [GLOBAL_ADMIN_ROLE];

/**
 * Pure predicate that names the
 * "is the caller cross-tenant privileged?" check used by inline
 * controller guards. Mirrors the existing service-side pattern
 * `Array.isArray(roles) && roles.includes(GLOBAL_ADMIN_ROLE)` so we don't
 * scatter the role literal across more controller files.
 *
 * The name `isSuperAdmin` is a legacy label kept as stable API
 * surface — it answers "is the caller a GLOBAL_ADMIN?".
 *
 * @example
 *   const user = this.cls.get('user');
 *   if (!isSuperAdmin(user) && id !== user?.tenantId) {
 *     throw new ForbiddenException();
 *   }
 */
export function isSuperAdmin(user: { roles?: string[] | null } | null | undefined): boolean {
  if (!user) return false;
  const roles = user.roles;
  return Array.isArray(roles) && roles.some((role) => ELEVATED_ROLES.includes(role));
}

/**
 * Assert that a child entity shares the same tenant as its parent.
 *
 * Use BEFORE any cross-aggregate write where a child row references a parent
 * (e.g. `Consultation -> Department`, `ContextItem -> Consultation`,
 * `Consultation.parentConsultationId -> Consultation` for revisits).
 *
 * Throws `NotFoundException` (not `ForbiddenException`) on tenant mismatch so
 * the caller cannot infer the existence of a parent in another tenant.
 *
 * @example
 *   const parent = await this.consultationRepository.findById(dto.parentId);
 *   assertEqualTenants(parent, { tenantId: this.tenantId });
 *
 *   // Or when both sides are real entities:
 *   assertEqualTenants(parentDepartment, childConsultation);
 *
 * @throws NotFoundException
 *   - `parent` is null/undefined (treat as not-found, no existence leak)
 *   - `parent.tenantId !== child.tenantId` (cross-tenant access, no leak)
 * @throws BadRequestException
 *   - `child` is null/undefined (caller bug)
 *   - either side's `tenantId` is null/undefined/empty (caller bug or data
 *     integrity — should never reach this branch in well-formed code)
 */
export function assertEqualTenants(
  parent: { tenantId?: string | null } | null | undefined,
  child: { tenantId?: string | null } | null | undefined,
): void {
  if (parent === null || parent === undefined) {
    throw new NotFoundException('Resource not found');
  }
  if (child === null || child === undefined) {
    throw new BadRequestException('Child reference is required');
  }

  const parentTenant = parent.tenantId;
  if (parentTenant === null || parentTenant === undefined || parentTenant === '') {
    throw new BadRequestException('Parent resource is missing tenant context');
  }

  const childTenant = child.tenantId;
  if (childTenant === null || childTenant === undefined || childTenant === '') {
    throw new BadRequestException('Child resource is missing tenant context');
  }

  if (parentTenant !== childTenant) {
    // Message MUST NOT carry the parent's tenantId — that would leak the
    // existence of a cross-tenant resource back to the caller.
    throw new NotFoundException('Resource not found');
  }
}

/**
 * Run a repository lookup and normalise its two failure shapes to `null`.
 *
 * `Repository.findFirst` throws `DataNotFoundException` on a miss in
 * production, but tests across the codebase mock it as returning `null`, so
 * both must be tolerated. Any OTHER error propagates unchanged.
 */
async function findFirstTolerant<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DataNotFoundException) return null;
    throw err;
  }
}

/**
 * Assert that the given `userId` is a member of the given `tenantId`.
 *
 * A user's tenant membership is modeled by two
 * tenant-scoped join tables and is only valid when BOTH halves are present:
 *   - an `ENABLED` `UserRoleAssignment` (the **role** half), and
 *   - an `ENABLED` `UserDepartment` (the **department** half).
 *
 * **Exemption:** service accounts (`User.isServiceAccount === true`) are
 * exempt from the department half — a role assignment alone is sufficient.
 * `GLOBAL_ADMIN`s are global (their assignments live under the SYSTEM tenant),
 * so the role-half check already excludes them from a specific tenant.
 *
 * Use BEFORE creating any tenant-scoped row that references a `User`
 * (e.g. `Consultation.doctorId`, `ApiKey.userId`, `Notification.targetUserId`)
 * to enforce the membership invariant.
 *
 * Throws `NotFoundException` on incomplete/absent membership (NO existence
 * leak) and tolerates each repository's two failure shapes (`null` OR
 * `DataNotFoundException`).
 *
 * @example
 *   await assertUserBelongsToTenant(
 *     this.userRoleAssignmentRepository,
 *     this.userDepartmentRepository,
 *     this.userRepository,
 *     request.doctorId,
 *     this.tenantId,
 *   );
 *
 * @throws BadRequestException — `userId` or `tenantId` is null/undefined/empty
 * @throws NotFoundException — no enabled role assignment, or (for a non-exempt
 *   user) no enabled department assignment (no leak)
 */
export async function assertUserBelongsToTenant(
  userRoleAssignmentRepository: UserRoleAssignmentRepository,
  userDepartmentRepository: UserDepartmentRepository,
  userRepository: UserRepository,
  userId: string,
  tenantId: string,
): Promise<void> {
  if (userId === null || userId === undefined || userId === '') {
    throw new BadRequestException('userId is required');
  }
  if (tenantId === null || tenantId === undefined || tenantId === '') {
    throw new BadRequestException('tenantId is required');
  }

  // 1. Role half — an enabled UserRoleAssignment in this tenant. Its absence
  //    means the user is not a member of this tenant at all (no leak).
  const roleAssignment = await findFirstTolerant(() =>
    userRoleAssignmentRepository.findFirst({
      where: { userId, tenantId, resourceStatus: ResourceStatusType.ENABLED },
    }),
  );
  if (roleAssignment === null || roleAssignment === undefined) {
    throw new NotFoundException('Resource not found');
  }

  // 2. Department half — an enabled UserDepartment in this tenant.
  const departmentAssignment = await findFirstTolerant(() =>
    userDepartmentRepository.findFirst({
      where: { userId, tenantId, resourceStatus: ResourceStatusType.ENABLED },
    }),
  );
  if (departmentAssignment !== null && departmentAssignment !== undefined) {
    return; // full member: role + department
  }

  // 3. No department — permitted ONLY for exempt users (service accounts).
  const user = await findFirstTolerant(() => userRepository.findFirst({ where: { id: userId } }));
  if (user && (user as { isServiceAccount?: boolean }).isServiceAccount === true) {
    return; // exempt — department not required
  }

  // Regular user with a role but no department = incomplete membership.
  throw new NotFoundException('Resource not found');
}

/**
 * Load a parent by id from the given repository and assert its `tenantId`
 * matches the caller's tenant. Returns the loaded parent on success;
 * throws `NotFoundException` on miss or tenant mismatch.
 *
 * Sugar over `repo.findById(id) + assertEqualTenants(parent, { tenantId })`
 * for the very common pattern at the top of a service write method.
 *
 * Tolerates both repository failure shapes (returns `null` *or* throws
 * `DataNotFoundException`), mirroring `assertUserBelongsToTenant`.
 *
 * @example
 *   const parent = await assertParentInScope(
 *     this.consultationRepository,
 *     dto.parentConsultationId,
 *     this.tenantId,
 *   );
 *
 * @throws NotFoundException — parent missing or in a different tenant
 */
export async function assertParentInScope<T extends { id: string; tenantId?: string | null }>(
  repository: { findById(id: string): Promise<T | null> },
  parentId: string,
  callerTenantId: string,
): Promise<T> {
  let parent: T | null;
  try {
    parent = await repository.findById(parentId);
  } catch (err) {
    if (err instanceof DataNotFoundException) {
      throw new NotFoundException('Resource not found');
    }
    throw err;
  }

  if (parent === null || parent === undefined) {
    throw new NotFoundException('Resource not found');
  }

  assertEqualTenants(parent, { tenantId: callerTenantId });
  return parent;
}
