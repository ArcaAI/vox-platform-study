/**
 * TASK-993 lane J, item 2 — the audited client address on the ONE route that
 * accepts a service-account client secret.
 *
 * `POST /auth/service-token` stamps the caller's address onto the exchange,
 * which is what lands in the audit trail for every machine identity the
 * platform issues a token to. It read `X-Forwarded-For` first. Behind this
 * platform's ingress (`Cloudflare edge → cloudflared → Traefik → pod`) that
 * header's last hop is the CLOUDFLARED POD, so every one of those rows named
 * a piece of infrastructure — and, worse, the header is caller-supplied, so
 * anyone talking to the gateway directly could write whatever address they
 * liked into the audit record of their own credential exchange.
 *
 * The rule is now the one lane A established for the rate limiter, from the
 * one shared implementation: a claimed address is believed only when the
 * SOCKET PEER is a declared ingress, and only from `CF-Connecting-IP`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ServiceAccountTokenController } from '../service-account-token.controller';

function makeController() {
  const service = { exchangeToken: vi.fn().mockResolvedValue({ accessToken: 'tok', expiresIn: 900 }) };
  return { controller: new ServiceAccountTokenController(service as never), service };
}

async function exchangeFrom(request: unknown): Promise<string> {
  const { controller, service } = makeController();
  await controller.exchange({ clientId: 'c1', clientSecret: 's1' } as never, request as never);
  return service.exchangeToken.mock.calls[0]![1] as string;
}

const original = process.env.RATE_LIMIT_TRUSTED_PROXIES;
beforeEach(() => {
  delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
});
afterEach(() => {
  if (original === undefined) delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
  else process.env.RATE_LIMIT_TRUSTED_PROXIES = original;
});

describe('service-token exchange — which address is audited', () => {
  it('IGNORES X-Forwarded-For entirely, even when it is the only header present', async () => {
    // The header names cloudflared on this path, and is caller-supplied off it.
    const audited = await exchangeFrom({
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      socket: { remoteAddress: '10.42.0.7' },
      ip: '10.42.0.7',
    });
    expect(audited).toBe('10.42.0.7');
  });

  it('IGNORES CF-Connecting-IP from a peer that is not a declared ingress', async () => {
    const audited = await exchangeFrom({
      headers: { 'cf-connecting-ip': '198.51.100.9' },
      socket: { remoteAddress: '203.0.113.200' },
      ip: '203.0.113.200',
    });
    expect(audited).toBe('203.0.113.200');
  });

  it('audits CF-Connecting-IP when the SOCKET PEER is a declared ingress', async () => {
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    const audited = await exchangeFrom({
      headers: { 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.5' },
      socket: { remoteAddress: '10.42.0.7' },
      ip: '10.42.0.7',
    });
    expect(audited).toBe('198.51.100.9');
  });

  it('reads the SOCKET peer for the trust check, never the (spoofable) req.ip', async () => {
    // `req.ip` is header-derived the moment anyone enables Express
    // `trust proxy`; a trust decision must not rest on it.
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.42.0.0/16';
    const audited = await exchangeFrom({
      headers: { 'cf-connecting-ip': '198.51.100.9' },
      socket: { remoteAddress: '203.0.113.200' },
      ip: '10.42.0.7',
    });
    expect(audited).toBe('203.0.113.200');
  });

  it('prefers the socket peer over req.ip when the two disagree', async () => {
    const audited = await exchangeFrom({ headers: {}, socket: { remoteAddress: '10.42.0.7' }, ip: '203.0.113.5' });
    expect(audited).toBe('10.42.0.7');
  });

  it('still records "unknown" when the request carries no address at all', async () => {
    expect(await exchangeFrom(undefined)).toBe('unknown');
    expect(await exchangeFrom({ headers: {} })).toBe('unknown');
  });
});
