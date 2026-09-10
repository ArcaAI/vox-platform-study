/**
 * TASK-950 — `extractUserIdentityValue`.
 *
 * The whole surface is "a string, or undefined". The tests that matter are the ABSENT ones:
 * every non-string shape must answer `undefined` rather than throwing or coercing, because the
 * schema validator has already run and rejected wrong types (plan D-2), and a second validator
 * here would be a competing gate that can disagree with the first.
 */

import { describe, expect, it } from 'vitest';
import { extractUserIdentityValue, type UserIdentityBinding } from '../extract-user-identity-value';

const BINDING: UserIdentityBinding = { kindKey: 'context', field: 'consultant_id' };

describe('extractUserIdentityValue', () => {
  it('returns the string at payload[kindKey][field]', () => {
    expect(extractUserIdentityValue({ context: { consultant_id: 'DR-1' } }, BINDING)).toBe('DR-1');
  });

  it('does not trim, coerce or otherwise touch the value — normalisation belongs to the service', () => {
    // The service owns trimming, because trimming is a DECISION (`'DR-1'` and `'DR-1 '` must be
    // the same clinician) and the test that proves it lives beside that decision.
    expect(extractUserIdentityValue({ context: { consultant_id: '  DR-1 ' } }, BINDING)).toBe('  DR-1 ');
    expect(extractUserIdentityValue({ context: { consultant_id: '' } }, BINDING)).toBe('');
  });

  it('reads the bound kind and field, not merely the first thing it finds', () => {
    const payload = { other: { consultant_id: 'WRONG' }, context: { consultant_id: 'RIGHT', staff_id: 'ALSO-WRONG' } };
    expect(extractUserIdentityValue(payload, BINDING)).toBe('RIGHT');
  });

  it('returns undefined when the payload itself is missing', () => {
    expect(extractUserIdentityValue(undefined, BINDING)).toBeUndefined();
    expect(extractUserIdentityValue(null, BINDING)).toBeUndefined();
    expect(extractUserIdentityValue({}, BINDING)).toBeUndefined();
  });

  it('returns undefined when the bound kind is absent or is not a plain object', () => {
    expect(extractUserIdentityValue({ somethingElse: { consultant_id: 'DR-1' } }, BINDING)).toBeUndefined();
    expect(extractUserIdentityValue({ context: null }, BINDING)).toBeUndefined();
    expect(extractUserIdentityValue({ context: 'DR-1' }, BINDING)).toBeUndefined();
    // A MANY-cardinality kind arrives as an array. Guarded explicitly rather than relying on
    // `['consultant_id']` happening to be undefined on an array.
    expect(extractUserIdentityValue({ context: [{ consultant_id: 'DR-1' }] }, BINDING)).toBeUndefined();
  });

  it('returns undefined when the bound field is absent or is not a string', () => {
    expect(extractUserIdentityValue({ context: { other: 'DR-1' } }, BINDING)).toBeUndefined();
    for (const value of [42, true, null, undefined, { nested: 'DR-1' }, ['DR-1']]) {
      expect(extractUserIdentityValue({ context: { consultant_id: value } }, BINDING), String(value)).toBeUndefined();
    }
  });
});
