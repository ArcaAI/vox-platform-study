/**
 * `redactId` must produce exactly what `hope_obs.phi.redact_id` produces, so one
 * patient's hashed id correlates across the gateway and all six Python services.
 *
 * The fixture pairs below were computed by running the Python function itself
 * (`packages/py-obs/src/hope_obs/phi.py`) — they are the parity contract, not
 * values derived from this implementation.
 */

import { describe, expect, it } from 'vitest';

import { redactId } from '../redact-id';

const PYTHON_FIXTURES: ReadonlyArray<[string | number | null | undefined, string]> = [
  ['0192f3a4-5b6c-7d8e-9f01-23456789abcd', 'a30db35c3ebf'],
  ['patient-123', '1985450135cd'],
  ['MRN-000042', '13b23ebea5ae'],
  [12345, '5994471abb01'],
  ['Ωmega-ü', 'f27846762c93'],
  ['', '-'],
  [null, '-'],
  [undefined, '-'],
];

describe('redactId', () => {
  it.each(PYTHON_FIXTURES)('redactId(%j) === %s (Python parity)', (input, expected) => {
    expect(redactId(input)).toBe(expected);
  });

  it('is stable: the same input always yields the same token', () => {
    expect(redactId('p-1')).toBe(redactId('p-1'));
    expect(redactId('p-1')).not.toBe(redactId('p-2'));
  });
});
