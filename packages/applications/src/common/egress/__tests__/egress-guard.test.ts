// TASK-846 D-3 — the SSRF egress guard, driven by the SHARED vector fixture.
//
// This suite and `apps/harness/src/harness/tests/unit/test_egress_guard.py` load the
// SAME file (`tests/fixtures/egress-vectors.json`) and assert the same verdict and the
// same reason code for every vector. That fixture is the only thing holding the two
// hand-written implementations together — there is deliberately no shared runtime
// package — so a rule changed on one side fails the other side's suite.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateEgress, isBlockedAddress } from '../egress-guard';

interface Vector {
  id: string;
  url: string;
  allowedHosts?: string[];
  expect: 'allow' | 'deny';
  reason?: string;
  pinned?: string[];
  note?: string;
}

interface Fixture {
  defaultAllowedHosts: string[];
  dns: Record<string, string[]>;
  vectors: Vector[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../tests/fixtures/egress-vectors.json'), 'utf8'),
);

/** The stub resolver: the fixture's `dns` map, NXDOMAIN for anything absent. */
const stubResolver = async (hostname: string): Promise<string[]> => FIXTURE.dns[hostname.toLowerCase()] ?? [];

describe('evaluateEgress — the shared vector contract', () => {
  for (const vector of FIXTURE.vectors) {
    it(`${vector.id}: ${vector.expect}${vector.reason ? ` (${vector.reason})` : ''}`, async () => {
      const allowedHosts = vector.allowedHosts ?? FIXTURE.defaultAllowedHosts;
      const decision = await evaluateEgress(vector.url, allowedHosts, stubResolver);

      expect(decision.allowed, `${vector.id} — ${vector.note ?? ''}`).toBe(vector.expect === 'allow');

      if (vector.expect === 'deny') {
        expect(decision.reason, vector.id).toBe(vector.reason);
      } else {
        expect(decision.reason, vector.id).toBeUndefined();
        // An ALLOW must hand back the exact addresses it validated — that set is
        // what the caller is obliged to connect to (see the DNS-rebinding note in
        // the guard's header).
        expect(decision.pinned, vector.id).toEqual(vector.pinned);
      }
    });
  }

  it('covers every vector in the fixture (no silent skips)', () => {
    expect(FIXTURE.vectors.length).toBeGreaterThanOrEqual(38);
  });
});

// FAIL-CLOSED. The allow-list is a SECURITY control read from the control plane, so
// "we could not read it" must deny. `null`/`undefined` is how both the settings
// resolver (`failMode: 'closed'` → no value) and the harness pull route
// (`snapshot.setting()` → None) report an UNRESOLVED key, and it is deliberately a
// DIFFERENT reason code from an empty list so the two are distinguishable in a log.
describe('evaluateEgress — fail-closed when the allow-list is unresolvable', () => {
  it('denies with `allowlist_unavailable` when the list is null', async () => {
    const decision = await evaluateEgress('https://mcp.partner.example.com/mcp', null, stubResolver);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('allowlist_unavailable');
  });

  it('denies with `allowlist_unavailable` when the list is undefined', async () => {
    const decision = await evaluateEgress('https://mcp.partner.example.com/mcp', undefined, stubResolver);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('allowlist_unavailable');
  });

  it('denies with `allowlist_unavailable` when the stored value is not an array of strings', async () => {
    // A malformed GlobalSetting row must not be coerced into "allow everything".
    for (const malformed of ['mcp.partner.example.com', 42, {}, [1, 2], [null]]) {
      const decision = await evaluateEgress('https://mcp.partner.example.com/mcp', malformed as never, stubResolver);
      expect(decision.allowed, JSON.stringify(malformed)).toBe(false);
      expect(decision.reason, JSON.stringify(malformed)).toBe('allowlist_unavailable');
    }
  });

  it('denies when the resolver itself throws — a DNS outage is never an allow', async () => {
    const decision = await evaluateEgress('https://mcp.partner.example.com/mcp', ['mcp.partner.example.com'], async () => {
      throw new Error('SERVFAIL');
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unresolvable');
  });
});

// The address classifier is the half that must never be bypassable, so it is pinned
// directly as well as through the URL-level vectors.
describe('isBlockedAddress — the explicit range table', () => {
  it.each([
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['169.254.0.0', 'link-local lower bound'],
    ['169.254.255.255', 'link-local upper bound'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback upper bound'],
    ['10.0.0.0', 'RFC1918 10/8 lower bound'],
    ['10.255.255.255', 'RFC1918 10/8 upper bound'],
    ['172.16.0.0', 'RFC1918 172.16/12 lower bound'],
    ['172.31.255.255', 'RFC1918 172.16/12 upper bound'],
    ['192.168.0.0', 'RFC1918 192.168/16 lower bound'],
    ['192.168.255.255', 'RFC1918 192.168/16 upper bound'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.0', 'CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd00::1', 'IPv6 ULA'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:10.0.0.1', 'IPv4-mapped RFC1918'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['64:ff9b::a9fe:a9fe', 'NAT64-embedded metadata'],
    ['2002:0a00:0001::1', '6to4-embedded RFC1918'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['203.0.113.10', 'TEST-NET-3 — must stay usable, unlike stdlib is_private'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'just ABOVE the 172.16/12 block'],
    ['172.15.255.255', 'just BELOW the 172.16/12 block'],
    ['11.0.0.1', 'just above 10/8'],
    ['9.255.255.255', 'just below 10/8'],
    ['169.253.255.255', 'just below link-local'],
    ['169.255.0.0', 'just above link-local'],
    ['2606:4700::1111', 'public IPv6'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('treats an unparseable address as BLOCKED, never as allowed', () => {
    for (const junk of ['', 'not-an-ip', '999.999.999.999', '10.0.0', 'localhost']) {
      expect(isBlockedAddress(junk), junk).toBe(true);
    }
  });
});
