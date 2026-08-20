/**
 * ServiceReleaseTokenGuard unit tests.
 *
 * @vitest-environment node
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceReleaseTokenGuard } from '../service-release-token.guard';

const createMockSecretsService = (secrets: Record<string, string | undefined>) => ({
  getSecretOptional: vi.fn(async (name: string) => secrets[name]),
});

function contextWithHeaders(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('ServiceReleaseTokenGuard', () => {
  let secretsService: ReturnType<typeof createMockSecretsService>;
  let guard: ServiceReleaseTokenGuard;

  beforeEach(() => {
    secretsService = createMockSecretsService({
      TEXT_SERVICE_TOKEN: 'text-secret',
      NLP_SERVICE_TOKEN: 'nlp-secret',
      GUARDRAIL_SERVICE_TOKEN: undefined,
      HARNESS_SERVICE_TOKEN: undefined,
      TTS_SERVICE_TOKEN: undefined,
      API_GATEWAY_KEY: 'gateway-secret',
    });
    guard = new ServiceReleaseTokenGuard(secretsService as any);
  });

  it('rejects a missing X-Service-Token header', async () => {
    await expect(guard.canActivate(contextWithHeaders({}))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid X-Service-Token that matches no configured secret', async () => {
    await expect(guard.canActivate(contextWithHeaders({ 'x-service-token': 'not-a-real-token' }))).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a token matching any one configured per-service secret', async () => {
    await expect(guard.canActivate(contextWithHeaders({ 'x-service-token': 'text-secret' }))).resolves.toBe(true);
    await expect(guard.canActivate(contextWithHeaders({ 'x-service-token': 'gateway-secret' }))).resolves.toBe(true);
  });

  it('rejects a token that only matches an unconfigured secret name', async () => {
    // GUARDRAIL_SERVICE_TOKEN resolves to undefined in this fixture — no
    // value to compare against, so it can never match.
    await expect(guard.canActivate(contextWithHeaders({ 'x-service-token': 'undefined' }))).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when SecretsService itself is unavailable', async () => {
    const guardWithoutSecrets = new ServiceReleaseTokenGuard(undefined);
    await expect(guardWithoutSecrets.canActivate(contextWithHeaders({ 'x-service-token': 'anything' }))).rejects.toThrow(UnauthorizedException);
  });

  it('accepts an array header value by taking the first entry', async () => {
    await expect(guard.canActivate(contextWithHeaders({ 'x-service-token': ['text-secret', 'other'] }))).resolves.toBe(true);
  });
});
