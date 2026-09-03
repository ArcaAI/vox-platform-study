// the egress allow-list's CONFIG-TIER contract.
//
// The tier here is not a detail; it is most of the control. This key decides which hosts
// a tenant-authored connector may reach, so the two properties that must never regress
// are (a) only the PLATFORM can write it, and (b) an unreadable value denies.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { effectiveResolverLane } from '../effective-settings.service';
import { MCP_EGRESS_ALLOWED_HOSTS_KEY } from '../descriptors/mcp-egress.descriptors';
import { MCP_EGRESS_ALLOWED_HOSTS_KEY as CONSUMER_KEY } from '../../../common/egress/egress-policy.service';

const descriptor = () => HOPE_SETTINGS_REGISTRY.getOrThrow(MCP_EGRESS_ALLOWED_HOSTS_KEY);

describe('mcp.egress.allowedHosts — registration', () => {
  it('is registered in the assembled registry', () => {
    expect(descriptor().key).toBe('mcp.egress.allowedHosts');
  });

  it('the reader and the descriptor name the SAME key', () => {
    // `common/` must not import `services/settings-registry/`, so the key string is
    // duplicated in `egress-policy.service.ts`. This is what stops the copy drifting —
    // a rename on one side would otherwise leave the guard reading a key nobody writes,
    // which reads at runtime as "allow-list unset" and denies every connector.
    expect(CONSUMER_KEY).toBe(MCP_EGRESS_ALLOWED_HOSTS_KEY);
  });
});

describe('mcp.egress.allowedHosts — tier and scope', () => {
  it('lives in `global-kv` — retunable without a redeploy, and not an env var', () => {
    // An allow-list you can only change by shipping an image is one nobody tightens
    // during an incident.
    expect(descriptor().tier).toBe('global-kv');
    expect(descriptor().targetTier).toBeUndefined();
  });

  it('is PLATFORM-only: system maxScope + globalOnly', () => {
    // The party this control constrains is the tenant. A tenant that could write it
    // could write itself `169.254.169.254`, which is the whole exposure back again.
    expect(descriptor().maxScope).toBe('system');
    expect(descriptor().globalOnly).toBe(true);
  });

  it('declares no tenant floor — it is not a tighten-only tenant knob, it is platform-owned', () => {
    expect(descriptor().floorDirection).toBeUndefined();
  });

  it('is served to the harness on the pull route, and has a resolver lane to serve', () => {
    expect(descriptor().consumedBy).toEqual(['harness']);
    expect(effectiveResolverLane(descriptor())).toBe('global-kv');
  });

  it('is not a secret — the set of reachable hosts is a boundary, not credential material', () => {
    // It must NOT be `secret`: the pull route filters secrets out unconditionally, so
    // marking it secret would silently stop the harness ever receiving it.
    expect(descriptor().sensitivity).toBe('internal');
  });
});

describe('mcp.egress.allowedHosts — FAIL CLOSED', () => {
  it('declares failMode `closed` — a security control has no safe default to fall back to', () => {
    expect(descriptor().failMode).toBe('closed');
  });

  it('its stated default is the EMPTY list, so even a code path that wrongly consulted it denies', () => {
    // `failMode: 'closed'` means the default is never substituted. Stating `[]` anyway
    // makes the fail-safe direction hold even if some future caller got that wrong.
    expect(descriptor().default).toEqual([]);
  });
});

describe('mcp.egress.allowedHosts — write-lane validation', () => {
  const check = (value: unknown) => descriptor().validate?.(value);

  it('accepts exact hosts and leading-dot suffixes', () => {
    expect(check(['terminology.partner.example.com', '.partner.example.com'])).toBeUndefined();
    expect(check([])).toBeUndefined();
  });

  it('refuses a non-array', () => {
    expect(check('terminology.partner.example.com')).toMatch(/array/i);
  });

  it('refuses an empty or non-string entry', () => {
    expect(check([''])).toMatch(/non-empty/i);
    expect(check(['  '])).toMatch(/non-empty/i);
    expect(check([42])).toMatch(/non-empty/i);
  });

  it('refuses a URL rather than a bare host — the author expected semantics this key does not have', () => {
    // Accepting these would be worse than refusing: they would never match anything,
    // and the admin would read that as "the allow-list is broken".
    expect(check(['https://terminology.partner.example.com'])).toMatch(/bare host/i);
    expect(check(['terminology.partner.example.com/mcp'])).toMatch(/bare host/i);
    expect(check(['terminology.partner.example.com:8443'])).toMatch(/bare host/i);
    expect(check(['user@terminology.partner.example.com'])).toMatch(/bare host/i);
  });

  it('refuses a `*` wildcard and points at the leading-dot form instead', () => {
    expect(check(['*.partner.example.com'])).toMatch(/leading dot/i);
  });
});
