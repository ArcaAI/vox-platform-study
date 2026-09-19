/**
 * TASK-993 lane A — the trust primitive behind the rate limiter's bucket key.
 *
 * `resolveClientIp` decides whether a request's claimed client address is
 * believed. Getting it wrong in one direction leaves every client sharing one
 * bucket (the D-1 defect); getting it wrong in the other hands any direct
 * caller a private bucket for free. Both directions are asserted here, plus the
 * parsing corners that make the check silently never fire.
 */

import { describe, it, expect } from 'vitest';
import { isTrustedProxy, parseIp, parseTrustedProxies, resolveClientIp } from '../client-ip';

/** A request shaped the way Express hands one to the throttler. */
function req(peer: string, claimed?: string | string[]): Record<string, unknown> {
  return {
    ip: peer,
    socket: { remoteAddress: peer },
    headers: claimed === undefined ? {} : { 'cf-connecting-ip': claimed },
  };
}

describe('parseIp', () => {
  it('parses IPv4 and rejects out-of-range octets', () => {
    expect(parseIp('10.0.0.1')).toEqual({ value: 0x0a000001n, bits: 32 });
    expect(parseIp('255.255.255.255')).toEqual({ value: 0xffffffffn, bits: 32 });
    expect(parseIp('256.0.0.1')).toBeNull();
    expect(parseIp('10.0.0')).toBeNull();
    expect(parseIp('not-an-ip')).toBeNull();
    expect(parseIp('')).toBeNull();
  });

  it('parses IPv6, including the compressed and bracketed forms', () => {
    expect(parseIp('::1')).toEqual({ value: 1n, bits: 128 });
    expect(parseIp('[::1]')).toEqual({ value: 1n, bits: 128 });
    expect(parseIp('fe80::1%eth0')).toEqual({ value: parseIp('fe80::1')?.value, bits: 128 });
    expect(parseIp('fe80:0:0:0:0:0:0:1')).toEqual(parseIp('fe80::1'));
    expect(parseIp('::')).toEqual({ value: 0n, bits: 128 });
    expect(parseIp(':::1')).toBeNull();
    expect(parseIp('gggg::1')).toBeNull();
  });

  it('FOLDS an IPv4-mapped IPv6 address to its IPv4 form', () => {
    // Not cosmetic: a dual-stack listener reports the peer as `::ffff:10.0.0.5`
    // while an operator writes the trusted list as `10.0.0.0/8`. Without the
    // fold those never match and the whole trust check is dead code.
    expect(parseIp('::ffff:10.0.0.5')).toEqual(parseIp('10.0.0.5'));
    expect(parseIp('::ffff:a00:5')).toEqual(parseIp('10.0.0.5'));
  });
});

describe('parseTrustedProxies', () => {
  it('accepts CIDR blocks, bare addresses and surrounding whitespace', () => {
    expect(parseTrustedProxies('10.42.0.0/16, 127.0.0.1 ,::1/128')).toHaveLength(3);
    expect(parseTrustedProxies('127.0.0.1')).toEqual([{ value: 0x7f000001n, bits: 32, prefix: 32 }]);
  });

  it('treats an unset or empty list as "trust nothing"', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('')).toEqual([]);
    expect(parseTrustedProxies(' , ')).toEqual([]);
  });

  it('DROPS an unparseable entry instead of throwing', () => {
    // A typo in a topology variable must not refuse the gateway's boot, and
    // dropping narrows the trust — the safe direction.
    expect(parseTrustedProxies('nonsense, 10.0.0.0/8')).toHaveLength(1);
    expect(parseTrustedProxies('10.0.0.0/33')).toEqual([]);
    expect(parseTrustedProxies('10.0.0.0/-1')).toEqual([]);
    expect(parseTrustedProxies('10.0.0.0/abc')).toEqual([]);
  });
});

describe('isTrustedProxy', () => {
  const trusted = parseTrustedProxies('10.42.0.0/16,192.0.2.7,2001:db8::/32');

  it('matches inside a v4 block and not outside it', () => {
    expect(isTrustedProxy('10.42.0.1', trusted)).toBe(true);
    expect(isTrustedProxy('10.42.255.254', trusted)).toBe(true);
    expect(isTrustedProxy('10.43.0.1', trusted)).toBe(false);
    expect(isTrustedProxy('127.0.0.1', trusted)).toBe(false);
  });

  it('matches a bare address exactly', () => {
    expect(isTrustedProxy('192.0.2.7', trusted)).toBe(true);
    expect(isTrustedProxy('192.0.2.8', trusted)).toBe(false);
  });

  it('matches inside a v6 block and never across families', () => {
    expect(isTrustedProxy('2001:db8::1', trusted)).toBe(true);
    expect(isTrustedProxy('2001:db9::1', trusted)).toBe(false);
    // A v6 entry must never be satisfied by a v4 address that happens to share
    // low bits, and vice versa.
    expect(isTrustedProxy('::a2a:1', trusted)).toBe(false);
  });

  it('matches a v4-mapped peer against a v4 block', () => {
    expect(isTrustedProxy('::ffff:10.42.0.1', trusted)).toBe(true);
  });

  it('trusts nothing when the list is empty or the address is junk', () => {
    expect(isTrustedProxy('10.42.0.1', [])).toBe(false);
    expect(isTrustedProxy(undefined, trusted)).toBe(false);
    expect(isTrustedProxy('not-an-ip', trusted)).toBe(false);
  });
});

describe('resolveClientIp', () => {
  const trusted = parseTrustedProxies('10.42.0.0/16');

  it('promotes CF-Connecting-IP when the SOCKET PEER is a declared ingress', () => {
    expect(resolveClientIp(req('10.42.0.9', '203.0.113.5'), trusted)).toBe('203.0.113.5');
  });

  it('IGNORES CF-Connecting-IP from a caller that is not a declared ingress', () => {
    // The security boundary: a direct caller must not be able to mint itself a
    // private bucket by asserting an address.
    expect(resolveClientIp(req('198.51.100.9', '203.0.113.5'), trusted)).toBeUndefined();
  });

  it('reads the SOCKET peer for the trust check, not the (spoofable) req.ip', () => {
    // If anyone ever enables Express `trust proxy`, `req.ip` becomes
    // header-derived. A trust decision must never rest on that.
    const spoofed = { ip: '10.42.0.9', socket: { remoteAddress: '198.51.100.9' }, headers: { 'cf-connecting-ip': '203.0.113.5' } };
    expect(resolveClientIp(spoofed, trusted)).toBeUndefined();
  });

  it('returns undefined — "use req.ip" — when nothing is declared trusted', () => {
    expect(resolveClientIp(req('10.42.0.9', '203.0.113.5'), [])).toBeUndefined();
  });

  it('refuses a claimed value that is not an address', () => {
    // Tracker cardinality is unbounded memory in the in-memory store and
    // unbounded key count in Redis.
    expect(resolveClientIp(req('10.42.0.9', 'not-an-ip'), trusted)).toBeUndefined();
    expect(resolveClientIp(req('10.42.0.9', '999.1.1.1'), trusted)).toBeUndefined();
    expect(resolveClientIp(req('10.42.0.9', ''), trusted)).toBeUndefined();
    expect(resolveClientIp(req('10.42.0.9'), trusted)).toBeUndefined();
  });

  it('takes the first hop if a middlebox appended to the header', () => {
    expect(resolveClientIp(req('10.42.0.9', '203.0.113.5, 10.42.0.9'), trusted)).toBe('203.0.113.5');
    expect(resolveClientIp(req('10.42.0.9', ['203.0.113.5', '198.51.100.1']), trusted)).toBe('203.0.113.5');
  });

  it('tolerates a request with no socket, headers or address at all', () => {
    expect(resolveClientIp(undefined, trusted)).toBeUndefined();
    expect(resolveClientIp({}, trusted)).toBeUndefined();
  });
});
