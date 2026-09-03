/**
 * (E1) — `verifyWebhookSignature`.
 *
 * The implementation under test is a zero-dependency, pure-TypeScript
 * HMAC-SHA256. These tests verify it INDEPENDENTLY, two ways:
 *
 *  1. Against the published RFC 4231 §4 HMAC-SHA256 test vectors, typed here
 *     as literal constants — no code in this repo produced them.
 *  2. Against Node's own `node:crypto.createHmac`, over payload lengths that
 *     straddle every SHA-256 padding boundary (55/56/63/64/119/120 bytes) and
 *     over key lengths that straddle the 64-byte HMAC block (short key,
 *     block-length key, over-length key that must be pre-hashed).
 *
 * `node:crypto` is a TEST-only import: `src/**` may not use it (the package is
 * WinterTC-portable and zero-dependency), which is exactly what makes it a
 * valid independent oracle here.
 *
 * The wire contract is fixed by the SIGNING side —
 * `packages/applications/src/services/webhook/webhook-delivery.processor.ts`:
 *   - header name `X-Hope-Webhook-Signature` (line 82)
 *   - header value `sha256=${createHmac('sha256', rawSecret).update(body).digest('hex')}`
 *                                                            (lines 307, 318)
 *   - `body` is `JSON.stringify(payload)` — so the receiver must verify the
 *     RAW request body, before any parse/re-serialize round trip.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from '../webhook-signature';
// The PUBLIC path an integrator actually writes. `check:exports` (attw +
// publint) proves the package's type/entry wiring but says nothing about WHICH
// symbols the barrel re-exports, so the reachability assertion lives here.
import * as publicEntry from '../../index';

/** Exactly how the gateway signs, so tests describe the real wire format. */
function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const SECRET = 'whsec_2f9c1e4a7b0d43f6a8c5e1b7d9f0a2c4';
const BODY = JSON.stringify({
  eventType: 'ResourceUpdated',
  resourceType: 'WorkflowRun',
  resourceId: '019260c7-4f3a-7c21-9f0b-2a6d5e8c1b34',
  tenantId: '50000000-0000-0000-0000-000000000000',
  occurredAt: '2026-09-03T10:15:30.000Z',
  fetchUrl: 'http://localhost:8868/api/v1/admin/workflow-runs/019260c7-4f3a-7c21-9f0b-2a6d5e8c1b34',
});

describe('WEBHOOK_SIGNATURE_HEADER', () => {
  it('is the header the delivery processor actually sends', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Hope-Webhook-Signature');
  });
});

describe('verifyWebhookSignature — RFC 4231 published vectors', () => {
  // RFC 4231 §4.2 — Test Case 1: key = 0x0b repeated 20 times, data = "Hi There".
  it('matches RFC 4231 test case 1', () => {
    const key = '\x0b'.repeat(20);
    const expected = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
    expect(verifyWebhookSignature('Hi There', `sha256=${expected}`, key)).toBe(true);
  });

  // RFC 4231 §4.3 — Test Case 2: key = "Jefe", data = "what do ya want for nothing?".
  it('matches RFC 4231 test case 2', () => {
    const expected = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
    expect(verifyWebhookSignature('what do ya want for nothing?', `sha256=${expected}`, 'Jefe')).toBe(true);
  });

  // RFC 4231 §4.5 — Test Case 4: key = 0x01..0x19 (25 bytes), data = 0xcd x50.
  // Both are ASCII-safe control/high bytes only up to 0x19, so the KEY is
  // expressible as a JS string; the DATA is supplied as bytes.
  it('matches RFC 4231 test case 4', () => {
    const key = String.fromCharCode(...Array.from({ length: 25 }, (_, i) => i + 1));
    const data = Uint8Array.from(new Array(50).fill(0xcd));
    const expected = '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b';
    expect(verifyWebhookSignature(data, `sha256=${expected}`, key)).toBe(true);
  });
});

describe('verifyWebhookSignature — accepts what the gateway signs', () => {
  it('accepts a genuine signature over the raw JSON body', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it('accepts the same body supplied as bytes', () => {
    const bytes = new TextEncoder().encode(BODY);
    expect(verifyWebhookSignature(bytes, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it('accepts an upper-case hex digest (receivers may normalise the header)', () => {
    const header = sign(BODY, SECRET).toUpperCase().replace('SHA256=', 'sha256=');
    expect(verifyWebhookSignature(BODY, header, SECRET)).toBe(true);
  });

  it('accepts a case-insensitive scheme prefix', () => {
    const hex = sign(BODY, SECRET).slice('sha256='.length);
    expect(verifyWebhookSignature(BODY, `SHA256=${hex}`, SECRET)).toBe(true);
  });

  it('tolerates surrounding whitespace introduced by a proxy', () => {
    expect(verifyWebhookSignature(BODY, `  ${sign(BODY, SECRET)}  `, SECRET)).toBe(true);
  });

  it('verifies a UTF-8 body containing multi-byte characters', () => {
    const body = JSON.stringify({ note: 'Patient reported “sharp” pain — 39°C. Ω' });
    expect(verifyWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it('verifies an empty body', () => {
    expect(verifyWebhookSignature('', sign('', SECRET), SECRET)).toBe(true);
  });
});

describe('verifyWebhookSignature — rejects forgeries', () => {
  it('rejects a signature made with a different secret', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, 'whsec_wrong'), SECRET)).toBe(false);
  });

  it('rejects a body altered after signing', () => {
    const header = sign(BODY, SECRET);
    expect(verifyWebhookSignature(`${BODY} `, header, SECRET)).toBe(false);
  });

  it('rejects a single-bit change in the digest', () => {
    const header = sign(BODY, SECRET);
    const flipped = `${header.slice(0, -1)}${header.endsWith('0') ? '1' : '0'}`;
    expect(verifyWebhookSignature(BODY, flipped, SECRET)).toBe(false);
  });

  it('rejects an empty secret rather than treating it as "unsigned"', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, ''), '')).toBe(false);
  });
});

describe('verifyWebhookSignature — rejects malformed headers', () => {
  const hex = sign(BODY, SECRET).slice('sha256='.length);

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['bare hex with no scheme', hex],
    ['wrong scheme', `sha1=${hex}`],
    ['scheme only', 'sha256='],
    ['digest too short', `sha256=${hex.slice(0, 62)}`],
    ['digest too long', `sha256=${hex}ab`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['odd separator', `sha256:${hex}`],
    ['two signatures', `sha256=${hex},sha256=${hex}`],
    ['embedded null', `sha256=${hex.slice(0, 63)}\0`],
  ])('rejects %s', (_label, header) => {
    expect(verifyWebhookSignature(BODY, header, SECRET)).toBe(false);
  });

  it('rejects non-string header values without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(verifyWebhookSignature(BODY, bad as unknown as string, SECRET)).toBe(false);
    }
  });

  it('rejects non-string secrets without throwing', () => {
    for (const bad of [null, undefined, 42, {}]) {
      expect(verifyWebhookSignature(BODY, sign(BODY, SECRET), bad as unknown as string)).toBe(false);
    }
  });
});

describe('verifyWebhookSignature — agrees with node:crypto across padding boundaries', () => {
  // SHA-256 pads to a 64-byte block with a 1 bit, zeroes, and a 64-bit length,
  // so 55/56 and 119/120 are exactly where an off-by-one in the padding shows.
  const lengths = [0, 1, 31, 32, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 255, 1024, 4096];

  it.each(lengths)('agrees for a %i-byte body', (length) => {
    const body = 'a'.repeat(length);
    expect(verifyWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  const keyLengths = [1, 16, 32, 63, 64, 65, 100, 200];

  it.each(keyLengths)('agrees for a %i-byte secret', (length) => {
    const secret = 'k'.repeat(length);
    expect(verifyWebhookSignature(BODY, sign(BODY, secret), secret)).toBe(true);
  });

  it('agrees over 200 pseudo-random body/secret pairs', () => {
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x85ebca6b) + 0xc2b2ae35) >>> 0;
      return seed;
    };
    for (let i = 0; i < 200; i += 1) {
      const bodyLen = next() % 300;
      const body = Array.from({ length: bodyLen }, () => String.fromCharCode(32 + (next() % 95))).join('');
      const secret = `s${next().toString(36)}`;
      expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true);
      expect(verifyWebhookSignature(body, sign(body, `${secret}x`), secret)).toBe(false);
    }
  });
});

describe('public entry point', () => {
  it('re-exports the helper and the header name from the package root', () => {
    expect(publicEntry.verifyWebhookSignature).toBe(verifyWebhookSignature);
    expect(publicEntry.WEBHOOK_SIGNATURE_HEADER).toBe(WEBHOOK_SIGNATURE_HEADER);
  });

  it('is usable exactly as the README documents, straight off the root barrel', () => {
    const body = JSON.stringify({ eventType: 'ResourceUpdated', resourceType: 'WorkflowRun' });
    const header = sign(body, SECRET);
    expect(publicEntry.verifyWebhookSignature(body, header, SECRET)).toBe(true);
    expect(publicEntry.verifyWebhookSignature(body, header, 'other-secret')).toBe(false);
  });
});
