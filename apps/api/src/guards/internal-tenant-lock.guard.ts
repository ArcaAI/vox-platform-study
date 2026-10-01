import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ITenantLockService, TENANT_LOCK_RETRY_AFTER_SECONDS, assertTenantNotLocked } from '@arcaai/applications';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TENANT_HEADERS = ['x-internal-tenant-id', 'x-tenant-id'];

interface InternalRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
}

const nonEmpty = (value: unknown): string | null => {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
};

/**
 * The restore lock for service-to-service (`/internal/*`) controllers.
 *
 * Those routes are `@Public()` or API-key routes whose handlers pin the CLS tenant themselves,
 * from the body, the query or an internal header, so the global `TenantLockGuard` cannot see the
 * tenant. This guard reads the same three places and refuses a MUTATING call (POST/PUT/PATCH/
 * DELETE) for a locked tenant with a 503 + `Retry-After: 30` carrying the same code/restoreId body (NOT 423:
 * STT and the harness treat 4xx as permanent and drop the write, but retry 503), before the handler runs.
 *
 * Apply it at controller level AFTER the controller's own service-token guard
 * (`@UseGuards(XServiceTokenGuard, InternalTenantLockGuard)`), so only authenticated callers
 * reach the lock lookup. Reads are not blocked: they write nothing, and refusing them would
 * only stall callers that retry.
 */
@Injectable()
export class InternalTenantLockGuard implements CanActivate {
  constructor(@Inject(ITenantLockService) private readonly lock: ITenantLockService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<InternalRequest>();
    if (!MUTATING_METHODS.has((req.method ?? '').toUpperCase())) return true;

    const tenantId = this.resolveTenantId(req);
    if (!tenantId) return true;

    try {
      await assertTenantNotLocked(this.lock, tenantId, { internal: true });
    } catch (error) {
      context
        .switchToHttp()
        .getResponse<{ setHeader?: (name: string, value: string) => void }>()
        ?.setHeader?.('Retry-After', String(TENANT_LOCK_RETRY_AFTER_SECONDS));
      throw error;
    }
    return true;
  }

  private resolveTenantId(req: InternalRequest): string | null {
    for (const name of TENANT_HEADERS) {
      const fromHeader = nonEmpty(req.headers?.[name]);
      if (fromHeader) return fromHeader;
    }
    const fromQuery = nonEmpty(req.query?.tenantId);
    if (fromQuery) return fromQuery;
    const body = req.body;
    if (body && typeof body === 'object') return nonEmpty((body as Record<string, unknown>).tenantId);
    return null;
  }
}
