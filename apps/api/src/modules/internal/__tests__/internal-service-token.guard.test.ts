// The generalized per-service internal token guard.
//
// Generalizes HarnessServiceTokenGuard: instead of one hardcoded secret, the
// guard validates the presented token against the secret belonging to the
// REQUESTED service, so an nlp token cannot read text's config subset.

import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

const makeContext = (headers: Record<string, string>, query: Record<string, string> = {}) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers, query }) }),
  }) as any;

const SECRETS: Record<string, string> = {
  // `TEXT_SERVICE_TOKEN` was here until TASK-888 retired it. It is left in the
  // fixture on purpose: the guard must not fall back to it now that `text`
  // resolves the shared token (see the last case in this describe).
  TEXT_SERVICE_TOKEN: 'text-token',
  NLP_SERVICE_TOKEN: 'nlp-token',
  GUARDRAIL_SERVICE_TOKEN: 'guardrail-token',
  HARNESS_SERVICE_TOKEN: 'harness-token',
  INTERNAL_ACCESS_TOKEN: 'shared-token',
  API_GATEWAY_KEY: 'stt-key',
};

const createSecretsService = (secrets: Record<string, string> = SECRETS) => ({
  getSecretOptional: vi.fn(async (name: string) => secrets[name]),
});

const guardWith = (secrets?: Record<string, string>) => new InternalServiceTokenGuard(createSecretsService(secrets) as any);

describe('InternalServiceTokenGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('per-service token binding', () => {
    it.each([
      // `text` joined `tts` on the ONE shared internal token in TASK-888 — the
      // service stopped accepting `TEXT_SERVICE_TOKEN` on its own side long ago.
      ['text', 'shared-token'],
      ['nlp', 'nlp-token'],
      ['guardrail', 'guardrail-token'],
      ['harness', 'harness-token'],
      ['tts', 'shared-token'],
    ])('allows %s with its own service token', async (service, token) => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': token }, { service }))).resolves.toBe(true);
    });

    it('no longer accepts the retired per-service TEXT_SERVICE_TOKEN for service=text', async () => {
      // The gateway would otherwise admit a credential `apps/text` itself can no
      // longer present, keeping a second thing to rotate alive on this side only.
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'text-token' }, { service: 'text' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it.each([['harness'], ['nlp'], ['guardrail']])(
      'accepts the ONE shared INTERNAL_ACCESS_TOKEN for service=%s — the token those peers present first (legacy secret stays a fallback)',
      async (service) => {
        // `apps/harness` `peer_service_token()` presents the shared token whenever it is
        // configured and only falls back to HARNESS_SERVICE_TOKEN when it is not; the
        // harness-specific gateway guard already accepts either. Measured 2026-09-07:
        // every durable `core.agent` node 401'd on `/internal/agents/resolve` because
        // this guard admitted only the legacy per-service secret.
        const guard = guardWith();
        await expect(guard.canActivate(makeContext({ 'x-service-token': 'shared-token' }, { service }))).resolves.toBe(true);
      },
    );

    it('rejects a valid token belonging to a DIFFERENT service (no cross-service reads)', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'nlp-token' }, { service: 'text' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('stt alternate header (existing X-Internal-Service-Key posture)', () => {
    it('accepts X-Internal-Service-Key for service=stt', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-internal-service-key': 'stt-key' }, { service: 'stt' }))).resolves.toBe(true);
    });

    it('does NOT accept X-Internal-Service-Key for any other service', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-internal-service-key': 'stt-key' }, { service: 'text' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('fail-closed', () => {
    it('rejects a missing token header', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({}, { service: 'text' }))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the service secret is unconfigured', async () => {
      const guard = guardWith({});
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'text-token' }, { service: 'text' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when SecretsService itself is absent from the graph', async () => {
      const guard = new InternalServiceTokenGuard(undefined);
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'text-token' }, { service: 'text' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a token of a different length without throwing (timingSafeEqual guard)', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'short' }, { service: 'text' }))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a missing service query param', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'text-token' }))).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('unknown service name', () => {
    // An AUTHENTICATED caller naming a bad service deserves the contract's 400
    // from the controller, so the guard lets a recognised token through and lets
    // the read service reject the name. An UNAUTHENTICATED caller still gets 401,
    // so the guard never becomes an unauthenticated service-name oracle.
    it('admits a caller holding any valid service token so the controller can answer 400', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'nlp-token' }, { service: 'nope' }))).resolves.toBe(true);
    });

    it('rejects an unknown service from a caller with no valid token', async () => {
      const guard = guardWith();
      await expect(guard.canActivate(makeContext({ 'x-service-token': 'garbage' }, { service: 'nope' }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
