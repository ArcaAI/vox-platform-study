import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { TENANTLESS, internalServiceHeaders, requestIdHeader } from '../internal-service-headers';

const options = { serviceToken: 'tok', tenantId: 't1', tenantlessReason: TENANTLESS.JOB_QUEUE };

describe('internalServiceHeaders X-Request-Id', () => {
  it('D6: includes the CLS request id', async () => {
    const cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
    let headers: Record<string, string> = {};
    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-42');
      headers = internalServiceHeaders(options);
    });
    expect(headers['X-Request-Id']).toBe('req-42');
    expect(headers['X-Tenant-Id']).toBe('t1');
  });

  it('D6: omits the header outside a request (no CLS scope) and lets extra override', () => {
    expect('X-Request-Id' in internalServiceHeaders(options)).toBe(false);
    expect(internalServiceHeaders({ ...options, extra: { 'X-Request-Id': 'mine' } })['X-Request-Id']).toBe('mine');
  });
});

describe('requestIdHeader (for clients that build their own headers)', () => {
  it('is { X-Request-Id } inside a request and {} outside one', async () => {
    const cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
    let inside: Record<string, string> = {};
    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-77');
      inside = requestIdHeader();
    });
    expect(inside).toEqual({ 'X-Request-Id': 'req-77' });
    expect(requestIdHeader()).toEqual({});
  });
});
