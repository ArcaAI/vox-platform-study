/**
 * `TenantOwnedResourceSseGuard` — TASK-309 SSE cross-tenant leak fix.
 *
 * The global `TenantOwnedResourceInterceptor` asserts `@TenantOwnedResource`
 * ownership and throws `404` on a tenant mismatch. That works for normal
 * request/response handlers, but NOT for `@Sse()` handlers: an SSE handler
 * returns its `Observable<MessageEvent>` synchronously and NestJS begins the
 * `text/event-stream` response before the interceptor's post-handler rejection
 * can take effect — so a cross-tenant probe of `:id/stream` leaks a `200` open
 * stream instead of a `404`.
 *
 * Guards run BEFORE the handler executes, so re-running the SAME ownership
 * assertion here rejects the request with `404` before the stream opens.
 *
 * Scope: this guard only acts on `@Sse()` handlers — every other route keeps
 * its existing single enforcement point (the interceptor). It MUST run after
 * `UnifiedAuthGuard` (which populates the CLS `tenantId` the assertion reads);
 * registration order in `AppModule.guards` guarantees that.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { TenantOwnedResourceInterceptor } from './tenant-owned-resource.interceptor';

@Injectable()
export class TenantOwnedResourceSseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly interceptor: TenantOwnedResourceInterceptor,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    // Only @Sse() handlers need the pre-stream check; the interceptor already
    // guards every non-SSE @TenantOwnedResource route correctly.
    const isSse = this.reflector.get<boolean | undefined>(SSE_METADATA, context.getHandler());
    if (!isSse) {
      return true;
    }

    // Throws NotFoundException (404) on a tenant mismatch; no-op when the
    // handler doesn't carry @TenantOwnedResource.
    await this.interceptor.assertAccess(context);
    return true;
  }
}
