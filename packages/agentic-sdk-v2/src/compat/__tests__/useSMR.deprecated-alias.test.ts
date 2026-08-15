/**
 * `useSMR` is a one-release deprecated re-export of `useText`
 * (naming-alignment: `smr` → `text`). This test guards the alias itself —
 * behavior is covered by `useText.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { useSMR } from '../useSMR';
import { useText } from '../useText';

describe('useSMR (deprecated alias)', () => {
  it('re-exports the same function as useText', () => {
    expect(useSMR).toBe(useText);
  });
});
