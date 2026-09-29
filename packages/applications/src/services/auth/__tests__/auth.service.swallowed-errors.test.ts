import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth.service';

const build = (fetchByExternalId: ReturnType<typeof vi.fn>) => {
  const userService = {
    fetchByExternalId,
    createExternalUser: vi.fn(async () => ({ id: 'new-user', username: 'u', tenantId: 't' })),
  };
  const eventEmitter = { emit: vi.fn() };
  const service = new AuthService(userService as never, eventEmitter as never);
  const logger = { warn: vi.fn(), error: vi.fn() };
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { service, userService, logger };
};

const request = { externalId: 'oidc-sub-1', username: 'u', email: 'u@example.test' } as never;

describe('AuthService.getOrCreateOidcUser — user lookup failures', () => {
  it('a genuine "no such user" still provisions the user', async () => {
    const { service, userService, logger } = build(vi.fn().mockRejectedValue(new NotFoundException('User not found')));

    await service.getOrCreateOidcUser(request);

    expect(userService.createExternalUser).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a database outage is logged and rethrown, and never provisions a duplicate user', async () => {
    const outage = new Error('ECONNREFUSED postgres');
    const { service, userService, logger } = build(vi.fn().mockRejectedValue(outage));

    await expect(service.getOrCreateOidcUser(request)).rejects.toBe(outage);

    expect(userService.createExternalUser).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
  });
});
