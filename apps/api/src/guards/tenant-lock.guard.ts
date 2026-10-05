import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { ITenantLockService, SKIP_AUTH_KEY, TENANT_LOCK_RETRY_AFTER_SECONDS, assertTenantNotLocked } from '@arcaai/applications';
import { isInternalPath } from './internal-path';
import { TENANT_LOCK_EXEMPT_KEY } from '../decorators/tenant-lock-exempt.decorator';

const TENANT_HEADER = 'x-tenant-id';

/**
 * Makes a tenant read-only-by-refusal while a restore holds its lock: every request that
 * resolves to the locked tenant answers 423 `TENANT_RESTORE_IN_PROGRESS`.
 *
 * Must run AFTER `UnifiedAuthGuard` (it reads the CLS tenant that guard resolves). WebSocket
 * contexts are delegated — the STT gateway checks the lock when it opens a session. When the
 * lock state cannot be read the request is refused with 503 rather than waved through.
 *
 * Internal routes (`/internal/*`) carry the tenant in `X-Tenant-Id`, not in CLS. When such a route is
 * authenticated by the global auth guard (STT's API-key route), this guard falls back to the header.
 * When it is `@Public()` — authenticated by a CONTROLLER guard, which runs after every global guard —
 * it does not: reading the lock there would answer a caller holding no credential (503 + restoreId
 * for a locked tenant, 401 otherwise). Those controllers carry `InternalTenantLockGuard` after their
 * token guard instead. `TenantLockService` runs its read under the tenant it is asked about, so the
 * missing CLS tenant does not trip the tenant-scope extension.
 */
@Injectable()
export class TenantLockGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    @Inject(ITenantLockService) private readonly lock: ITenantLockService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const exempt = this.reflector.getAllAndOverride<boolean>(TENANT_LOCK_EXEMPT_KEY, [context.getHandler(), context.getClass()]);
    if (exempt) return true;

    const tenantId = this.resolveTenantId(context);
    if (!tenantId) return true;

    // Service-to-service routes get the retryable 503; user-facing routes keep 423.
    const internal = isInternalPath(context.switchToHttp().getRequest());
    try {
      await assertTenantNotLocked(this.lock, tenantId, { internal });
    } catch (error) {
      if (internal) {
        context
          .switchToHttp()
          .getResponse<{ setHeader?: (name: string, value: string) => void }>()
          ?.setHeader?.('Retry-After', String(TENANT_LOCK_RETRY_AFTER_SECONDS));
      }
      throw error;
    }
    return true;
  }

  private resolveTenantId(context: ExecutionContext): string | null {
    if (this.cls.isActive()) {
      const direct = this.cls.get('tenantId') as unknown;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const fromUser = (this.cls.get('user') as { tenantId?: string | null } | undefined)?.tenantId;
      if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
    }
    const req = context.switchToHttp().getRequest<{ originalUrl?: string; url?: string; headers?: Record<string, string | string[] | undefined> }>();
    if (!isInternalPath(req) || this.isPublic(context)) return null;
    const header = req.headers?.[TENANT_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  /** `@Public()` (either marker the auth guard honours): not authenticated yet when global guards run. */
  private isPublic(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    return !!(this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, targets) || this.reflector.getAllAndOverride<boolean>('isPublic', targets));
  }
}
