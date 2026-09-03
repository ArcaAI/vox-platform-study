/**
 * the third credential class resolves a tenant on the FROZEN compat
 * surface.
 *
 * `requireTenantId` is the choke point every compat generation path funnels
 * through, and its existing fallback chain (CLS → `request.apiKey` →
 * `request.user`) exists because these routes are EXCLUDED from the `api/v1`
 * global prefix, where a CLS write made in `UnifiedAuthGuard` is not visible to
 * the controller. That was MEASURED on a live gateway during this ticket: the
 * guard authenticated a service account, wrote `workingTenantId` into CLS and
 * read it straight back — and the controller then saw nothing and answered 401.
 *
 * A machine principal deliberately carries neither `request.user` (its actions
 * must not be recorded against a person) nor `request.apiKey`, so it needed the
 * same request-attached branch the other two classes already had. These cases
 * pin all four branches and, critically, their ORDER: an explicitly-scoped
 * human credential must never be overridden by a machine's working tenant.
 */
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextCompatController } from '../text-compat.controller';

type RequireTenantId = { requireTenantId: (r?: object) => string };

const SERVICE_ACCOUNT_TENANT = '50000000-0000-0000-0000-000000000001';
const KEY_TENANT = '50000000-0000-0000-0000-0000000000aa';
const CLS_TENANT = '50000000-0000-0000-0000-0000000000bb';

describe('TextCompatController.requireTenantId — service-account branch', () => {
  let controller: TextCompatController;

  const build = (clsTenant?: string) =>
    new TextCompatController(
      { axiosRef: { post: vi.fn(), get: vi.fn() } } as never,
      { getConfigValue: vi.fn(() => 'http://localhost:8862') } as never,
      { get: vi.fn((key: string) => (key === 'tenantId' ? clsTenant : undefined)), getId: vi.fn(() => 'req-1') } as never,
      { resolveTextSelection: vi.fn(), resolveTextFallbackSelection: vi.fn() } as never,
      { toSummaryPromptType: vi.fn(), resolveGovernedInstruction: vi.fn() } as never,
    );

  beforeEach(() => {
    controller = build(undefined);
  });

  it('resolves the working tenant off request.serviceAccount when CLS is empty', () => {
    const request = { serviceAccount: { workingTenantId: SERVICE_ACCOUNT_TENANT } };
    expect((controller as unknown as RequireTenantId).requireTenantId(request)).toBe(SERVICE_ACCOUNT_TENANT);
  });

  it('still rejects when the machine principal carries no working tenant — no SYSTEM-default leak', () => {
    const request = { serviceAccount: { workingTenantId: undefined } };
    expect(() => (controller as unknown as RequireTenantId).requireTenantId(request)).toThrow(UnauthorizedException);
  });

  it('is the LAST fallback — an API key on the same request still wins', () => {
    const request = { apiKey: { tenantId: KEY_TENANT }, serviceAccount: { workingTenantId: SERVICE_ACCOUNT_TENANT } };
    expect((controller as unknown as RequireTenantId).requireTenantId(request)).toBe(KEY_TENANT);
  });

  it('is the LAST fallback — a populated CLS tenant still wins', () => {
    const withCls = build(CLS_TENANT);
    const request = { serviceAccount: { workingTenantId: SERVICE_ACCOUNT_TENANT } };
    expect((withCls as unknown as RequireTenantId).requireTenantId(request)).toBe(CLS_TENANT);
  });

  it('an unauthenticated request is unchanged — still 401, never a default tenant', () => {
    expect(() => (controller as unknown as RequireTenantId).requireTenantId(undefined)).toThrow(UnauthorizedException);
    expect(() => (controller as unknown as RequireTenantId).requireTenantId({})).toThrow(UnauthorizedException);
  });
});
