import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { ITenantLockService } from '@arcaai/applications';
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
 * Internal service-token routes (`/internal/*`) are `@Public()`, so no CLS tenant exists when
 * this guard runs; most pin it later inside the handler. For those the guard falls back to the
 * `X-Tenant-Id` header, which internal calls must carry.
 */
@Injectable()
export class TenantLockGuard implements CanActivate {
  private readonly logger = new Logger(TenantLockGuard.name);

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

    let state;
    try {
      state = await this.lock.state(tenantId);
    } catch (error) {
      this.logger.error({ message: 'Tenant lock state unreadable — refusing request', tenantId, error: String(error) });
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'TENANT_LOCK_UNAVAILABLE',
        message: 'Tenant lock state could not be determined',
      });
    }
    if (!state.locked) return true;

    throw new HttpException(
      {
        statusCode: 423,
        code: 'TENANT_RESTORE_IN_PROGRESS',
        message: 'This tenant is being restored from a checkpoint and is read-only until the restore finishes',
        restoreId: state.restoreId,
      },
      423,
    );
  }

  private resolveTenantId(context: ExecutionContext): string | null {
    if (this.cls.isActive()) {
      const direct = this.cls.get('tenantId') as unknown;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const fromUser = (this.cls.get('user') as { tenantId?: string | null } | undefined)?.tenantId;
      if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
    }
    const req = context.switchToHttp().getRequest<{ originalUrl?: string; url?: string; headers?: Record<string, string | string[] | undefined> }>();
    const url = req?.originalUrl ?? req?.url ?? '';
    if (!url.includes('/internal/')) return null;
    const header = req.headers?.[TENANT_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
