import { SetMetadata } from '@nestjs/common';

/** Reflector key for the `@TenantLockExempt()` marker. */
export const TENANT_LOCK_EXEMPT_KEY = 'tenantLockExempt';

/**
 * Lets a handler (or a whole controller) run while its tenant is locked by a restore.
 *
 * Reserved for the routes that operate the lock itself: the checkpoint and restore controllers
 * (status polling, cancel, upload) must stay reachable, or a locked tenant could never be
 * observed or released.
 */
export const TenantLockExempt = (): MethodDecorator & ClassDecorator => SetMetadata(TENANT_LOCK_EXEMPT_KEY, true);
