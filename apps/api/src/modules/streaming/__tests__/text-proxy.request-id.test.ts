import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { TextProxyController } from '../text-proxy.controller';

// The proxy assembles its own headers, so it must spread the request id in itself —
// otherwise TEXT mints a fresh one and the request cannot be followed across the hop.
describe('TextProxyController forward headers', () => {
  it('carry the gateway request id to TEXT', async () => {
    const cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
    const controller = Object.create(TextProxyController.prototype) as Record<string, unknown>;
    Object.assign(controller, { clsService: cls, secretsService: { getSecretSync: () => 'tok' } });

    let headers: Record<string, string> = {};
    await cls.run(async () => {
      (cls as ClsService<Record<symbol | string, unknown>>).set(CLS_ID, 'proof-req-1');
      cls.set('tenantId', 't-1');
      headers = (controller.getForwardHeaders as () => Record<string, string>).call(controller);
    });

    expect(headers['X-Request-Id']).toBe('proof-req-1');
    expect(headers['X-Tenant-Id']).toBe('t-1');
    expect(headers['X-Service-Token']).toBe('tok');
  });
});
