/**
 * `@ApiDeprecated` writes its notice into an HTTP header. Node refuses any header value outside
 * ISO-8859-1 with ERR_INVALID_CHAR, and the first notice carried an em-dash — every deprecated
 * route (23 of them after TASK-861/862) answered 500 until the e2e run caught it. Pinned here so
 * the notice text can be reworded without ever breaking a response again.
 */
import { describe, expect, it } from 'vitest';
import { ApiDeprecated, toHeaderSafe } from '../api-deprecated.decorator';

const HEADERS_METADATA = '__headers__';

function headersOf(options: Parameters<typeof ApiDeprecated>[0]): Record<string, string> {
  class Probe {
    handler(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!;
  ApiDeprecated(options)(Probe.prototype, 'handler', descriptor);
  const entries = (Reflect.getMetadata(HEADERS_METADATA, descriptor.value as object) ?? []) as Array<{ name: string; value: string }>;
  return Object.fromEntries(entries.map((h) => [h.name, h.value]));
}

const HEADER_SAFE = /^[\x20-\x7e]*$/;

describe('ApiDeprecated — header values are always transmissible', () => {
  it('emits Deprecation, an ASCII-only notice, and the successor Link', () => {
    const headers = headersOf({ ticket: 'TASK-861', removeIn: 'R4', replacement: '/api/v1/agents' });
    expect(headers.Deprecation).toBe('true');
    expect(headers['X-Deprecation-Notice']).toBe('TASK-861 - removed in R4; use /api/v1/agents');
    expect(headers.Link).toBe('</api/v1/agents>; rel="successor-version"');
    for (const [name, value] of Object.entries(headers)) expect(value, `${name} must be printable ASCII`).toMatch(HEADER_SAFE);
  });

  it('never lets a non-ASCII character reach the wire, whatever the caller passes', () => {
    const headers = headersOf({ ticket: 'TASK-862 — providers', removeIn: 'R3 → R4', replacement: '/api/v1/admin/providers' });
    expect(headers['X-Deprecation-Notice']).toMatch(HEADER_SAFE);
    expect(headers['X-Deprecation-Notice']).toContain('TASK-862 - providers');
  });

  it('toHeaderSafe replaces every character outside printable ASCII', () => {
    expect(toHeaderSafe('a — b → cé')).toBe('a - b - c-');
    expect(toHeaderSafe('plain ascii; use /x')).toBe('plain ascii; use /x');
  });
});
