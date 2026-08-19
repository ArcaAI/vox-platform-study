/**
 * ServiceAccountTokenController unit tests.
 *
 * This is the ONE route that ever accepts a service-account client secret,
 * so it must be `@Public()` (nothing to authenticate against yet) while
 * staying guarded by `ServiceAccountTokenGuard` — never bare-public. These
 * specs cover the controller's own logic: delegating to
 * `IServiceAccountService.exchangeToken` with the request body and the
 * resolved client IP (X-Forwarded-For first hop, falling back to
 * `req.ip`/`'unknown'`), plus pinning the `@Public()` + guard combination so
 * this credential-exchange endpoint can never silently become either fully
 * open or unreachable.
 */
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { SKIP_AUTH_KEY } from '@arcaai/applications';

import { ServiceAccountTokenController } from '../service-account-token.controller';
import { ServiceAccountTokenGuard } from '../service-account-token.guard';

function makeController() {
  const service = { exchangeToken: vi.fn().mockResolvedValue({ accessToken: 'tok', expiresIn: 900 }) };
  const controller = new ServiceAccountTokenController(service as never);
  return { controller, service };
}

describe('ServiceAccountTokenController — delegation', () => {
  it('exchanges with the request body and the x-forwarded-for first hop', async () => {
    const { controller, service } = makeController();
    const request = { body: {}, headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, ip: '10.0.0.1' };
    await controller.exchange({ clientId: 'c1', clientSecret: 's1' } as never, request as never);
    expect(service.exchangeToken).toHaveBeenCalledWith({ clientId: 'c1', clientSecret: 's1' }, '203.0.113.5');
  });

  it('falls back to req.ip when there is no x-forwarded-for header', async () => {
    const { controller, service } = makeController();
    const request = { headers: {}, ip: '10.0.0.1' };
    await controller.exchange({ clientId: 'c1', clientSecret: 's1' } as never, request as never);
    expect(service.exchangeToken).toHaveBeenCalledWith({ clientId: 'c1', clientSecret: 's1' }, '10.0.0.1');
  });

  it('falls back to "unknown" when neither is present', async () => {
    const { controller, service } = makeController();
    await controller.exchange({ clientId: 'c1', clientSecret: 's1' } as never, undefined as never);
    expect(service.exchangeToken).toHaveBeenCalledWith({ clientId: 'c1', clientSecret: 's1' }, 'unknown');
  });
});

describe('ServiceAccountTokenController — must be @Public() but guarded', () => {
  const reflector = new Reflector();

  it('the exchange route is @Public()', () => {
    const flag = reflector.get(SKIP_AUTH_KEY, ServiceAccountTokenController.prototype.exchange);
    expect(flag).toBe(true);
  });

  it('the exchange route still attaches ServiceAccountTokenGuard via @UseGuards', () => {
    const guards = Reflect.getMetadata('__guards__', ServiceAccountTokenController.prototype.exchange);
    expect(guards).toBeDefined();
    expect(guards).toContain(ServiceAccountTokenGuard);
  });
});
