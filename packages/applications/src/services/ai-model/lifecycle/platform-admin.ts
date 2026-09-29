import { ForbiddenException } from '@nestjs/common';
import { isSuperAdmin } from '../../../common/tenant-guards';

/**
 * The model-registry OPERATIONS gate: SUPER_ADMIN, in a tenant-LESS context.
 *
 * AUTH-NOTE: the controller's class-level `@Authorize(['manage','all'])`
 * understates this. Publishing weights into the shared bucket, deleting them,
 * and reading who uses a model across every tenant are platform administration
 * — the same shape as model residency (a working tenant selected is itself a
 * 403). The gate is ROW-INDEPENDENT, so it runs FIRST: an unknown model id is
 * still a 404 after it, and a non-platform caller gets the same 403 for every id.
 */
export function assertPlatformRegistryAdmin(
  user: { roles?: string[] | null } | null | undefined,
  workingTenantId: string | null | undefined,
  action: string,
): void {
  if (!isSuperAdmin(user)) {
    throw new ForbiddenException(`Only platform administrators may ${action}.`);
  }
  if (workingTenantId) {
    throw new ForbiddenException(`The model registry is platform-wide; clear the working tenant to ${action}.`);
  }
}
