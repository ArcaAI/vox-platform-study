/**
 * TASK-890 L7 — `signWebhookTrigger`, the OUTBOUND half of the webhook pair.
 *
 * `verifyWebhookSignature` (E1) checks what HOPE SENDS you. This checks what you send HOPE:
 * the inbound workflow trigger `POST /api/v1/hooks/workflows/{hookId}`, whose signature the
 * gateway verifies in `WorkflowExposureService.signWebhookTrigger`
 * (`packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts`):
 *
 * ```ts
 * `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
 * ```
 *
 * Two properties that a "just HMAC the body" implementation would get wrong, and which are
 * therefore asserted rather than assumed: the TIMESTAMP is inside the signed string (that is
 * what bounds replay against the gateway's 300s window), and it is joined with a literal `.`
 * — so a caller cannot move bytes across the boundary undetected.
 *
 * The oracle is the same one `webhook-signature.test.ts` uses and for the same reason:
 * `node:crypto` may not appear in `src/**` (zero runtime dependencies, WinterTC-portable),
 * which is exactly what makes it independent here. The RFC 4231 vectors pin the underlying
 * HMAC itself, and the padding boundaries (55/56/63/64/119/120) are where a hand-rolled
 * SHA-256 goes wrong if it does.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { WEBHOOK_TRIGGER_SIGNATURE_HEADER, WEBHOOK_TRIGGER_TIMESTAMP_HEADER, signWebhookTrigger, verifyWebhookSignature } from '../webhook-signature';
import * as publicEntry from '../../index';

/** Exactly how the GATEWAY signs an inbound trigger — transcribed, not derived. */
function gatewaySign(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

const SECRET = 'whsec_2f9c1e4a7b0d43f6a8c5e1b7d9f0a2c4';
const TIMESTAMP = '1788700800';
const BODY = JSON.stringify({ note: 'discharge summary please', urgency: 'routine' });

describe('signWebhookTrigger — byte-for-byte agreement with the verifying side', () => {
  it('matches node:crypto over "<timestamp>.<rawBody>"', () => {
    expect(signWebhookTrigger(SECRET, TIMESTAMP, BODY)).toBe(gatewaySign(SECRET, TIMESTAMP, BODY));
  });

  it('emits the `sha256=<64 lowercase hex>` scheme the gateway parses', () => {
    expect(signWebhookTrigger(SECRET, TIMESTAMP, BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it.each([0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 121, 200])('agrees at a %i-byte body (SHA-256 padding boundaries)', (length) => {
    const body = 'x'.repeat(length);
    expect(signWebhookTrigger(SECRET, TIMESTAMP, body)).toBe(gatewaySign(SECRET, TIMESTAMP, body));
  });

  it.each([
    ['short key', 'k'],
    ['block-length key (64 bytes)', 'k'.repeat(64)],
    ['over-length key, pre-hashed by HMAC', 'k'.repeat(200)],
  ])('agrees with a %s', (_label, secret) => {
    expect(signWebhookTrigger(secret, TIMESTAMP, BODY)).toBe(gatewaySign(secret, TIMESTAMP, BODY));
  });

  it('agrees over a multi-byte UTF-8 body (the digest covers BYTES, not characters)', () => {
    const body = JSON.stringify({ note: 'π ≈ 3.14159 — الملخص — 요약' });
    expect(signWebhookTrigger(SECRET, TIMESTAMP, body)).toBe(gatewaySign(SECRET, TIMESTAMP, body));
  });
});

describe('the timestamp is INSIDE the signed string', () => {
  it('changes the signature when only the timestamp changes', () => {
    expect(signWebhookTrigger(SECRET, TIMESTAMP, BODY)).not.toBe(signWebhookTrigger(SECRET, '1788700801', BODY));
  });

  it('signs exactly `${timestamp}.${rawBody}` — the same string the gateway rebuilds', () => {
    // Stated as a byte-level identity rather than as a collision-resistance claim, because the
    // `.`-joined scheme is NOT injective in general: ('1.2', '3') and ('1', '2.3') both join to
    // '1.2.3' and therefore sign identically. That is harmless here and worth writing down —
    // the gateway parses the timestamp with `Number(...)` and requires it finite AND within 300
    // seconds of its own clock, so a '.'-bearing timestamp is refused before the digest is ever
    // compared. The ambiguity is bounded by the timestamp's grammar, not by the separator.
    expect(signWebhookTrigger(SECRET, '1.2', '3')).toBe(signWebhookTrigger(SECRET, '1', '2.3'));
    expect(signWebhookTrigger(SECRET, TIMESTAMP, BODY)).toBe(gatewaySign(SECRET, TIMESTAMP, BODY));
  });

  it('accepts raw BYTES without a UTF-8 round trip, and agrees with the string form', () => {
    // An integrator that already holds the exact bytes it is about to POST must be able to sign
    // THOSE, not a re-encoding of them — the same rule the receiving side follows.
    const bytes = new TextEncoder().encode(BODY);
    expect(signWebhookTrigger(SECRET, TIMESTAMP, bytes)).toBe(gatewaySign(SECRET, TIMESTAMP, BODY));
  });
});

describe('the header names an integrator must send', () => {
  it('names the two headers the gateway reads', () => {
    expect(WEBHOOK_TRIGGER_SIGNATURE_HEADER).toBe('X-Hope-Signature');
    expect(WEBHOOK_TRIGGER_TIMESTAMP_HEADER).toBe('X-Hope-Timestamp');
  });

  it('is a DIFFERENT header from the one HOPE signs its own deliveries with', () => {
    // `X-Hope-Webhook-Signature` (outbound, body only) vs `X-Hope-Signature` (inbound,
    // timestamp + body). Same algorithm, different signed string — conflating them would make
    // an outbound delivery replayable as an inbound trigger.
    expect(WEBHOOK_TRIGGER_SIGNATURE_HEADER).not.toBe(publicEntry.WEBHOOK_SIGNATURE_HEADER);
  });

  it('is reachable from the package entry point an integrator imports', () => {
    expect(publicEntry.signWebhookTrigger).toBe(signWebhookTrigger);
    expect(publicEntry.WEBHOOK_TRIGGER_SIGNATURE_HEADER).toBe(WEBHOOK_TRIGGER_SIGNATURE_HEADER);
    expect(publicEntry.WEBHOOK_TRIGGER_TIMESTAMP_HEADER).toBe(WEBHOOK_TRIGGER_TIMESTAMP_HEADER);
  });
});

describe('the two signature functions do not verify each other', () => {
  it('a trigger signature does not verify as a delivery signature over the same body', () => {
    expect(verifyWebhookSignature(BODY, signWebhookTrigger(SECRET, TIMESTAMP, BODY), SECRET)).toBe(false);
  });

  it('but a trigger signature DOES verify as a delivery signature over the joined string', () => {
    // Not a recommendation — a statement of what the shared HMAC core means, so a future
    // refactor that "unifies" the two functions has to confront that they sign different inputs.
    expect(verifyWebhookSignature(`${TIMESTAMP}.${BODY}`, signWebhookTrigger(SECRET, TIMESTAMP, BODY), SECRET)).toBe(true);
  });
});
