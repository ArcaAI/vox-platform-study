/**
 * HarnessServiceTokenGuard Unit Tests
 *
 * Guards the /internal/harness/* endpoints: the harness must present a valid
 * `X-Service-Token` matching the `HARNESS_SERVICE_TOKEN` secret. Fail-closed —
 * a missing header, an unconfigured secret, or a mismatch all reject.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { HarnessServiceTokenGuard } from '../harness-service-token.guard';

const makeContext = (headers: Record<string, string>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as any;

const createMockSecretsService = (token?: string) => ({
  getSecretOptional: vi.fn().mockResolvedValue(token),
});

describe('HarnessServiceTokenGuard', () => {
  let secretsService: ReturnType<typeof createMockSecretsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    secretsService = createMockSecretsService('the-harness-token');
  });

  it('allows the request when X-Service-Token matches HARNESS_SERVICE_TOKEN', async () => {
    const guard = new HarnessServiceTokenGuard(secretsService as any);
    const result = await guard.canActivate(makeContext({ 'x-service-token': 'the-harness-token' }));
    expect(result).toBe(true);
    expect(secretsService.getSecretOptional).toHaveBeenCalledWith('HARNESS_SERVICE_TOKEN');
  });

  it('rejects when the X-Service-Token header is missing', async () => {
    const guard = new HarnessServiceTokenGuard(secretsService as any);
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the provided token does not match', async () => {
    const guard = new HarnessServiceTokenGuard(secretsService as any);
    await expect(guard.canActivate(makeContext({ 'x-service-token': 'wrong-token' }))).rejects.toThrow(UnauthorizedException);
  });

  it('fail-closed: rejects when HARNESS_SERVICE_TOKEN is not configured', async () => {
    const guard = new HarnessServiceTokenGuard(createMockSecretsService(undefined) as any);
    await expect(guard.canActivate(makeContext({ 'x-service-token': 'anything' }))).rejects.toThrow(UnauthorizedException);
  });

  it('fail-closed: rejects when SecretsService is unavailable', async () => {
    const guard = new HarnessServiceTokenGuard(undefined);
    await expect(guard.canActivate(makeContext({ 'x-service-token': 'anything' }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token of a different length (no timingSafeEqual length throw)', async () => {
    const guard = new HarnessServiceTokenGuard(secretsService as any);
    await expect(guard.canActivate(makeContext({ 'x-service-token': 'short' }))).rejects.toThrow(UnauthorizedException);
  });
});
