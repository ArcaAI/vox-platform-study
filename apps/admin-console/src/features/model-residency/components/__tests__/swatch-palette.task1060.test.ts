/**
 * TASK-1060 — the CPU bar shows every service side by side, so no two swatches may share a
 * neutral: Text-to-speech and "Other workloads & system" were both grey on the cluster.
 */

import { describe, expect, it } from 'vitest';
import { SERVICE_SWATCH } from '../gpu-memory-bar';

const NEUTRAL = /^bg-(primary|chart-5|secondary-foreground|muted-foreground|neutral-)/;

describe('SERVICE_SWATCH palette', () => {
  it('gives every service its own swatch', () => {
    const values = Object.values(SERVICE_SWATCH);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps neutrals for the gateway and "other" only, and never the same neutral for both', () => {
    const neutral = Object.entries(SERVICE_SWATCH)
      .filter(([, cls]) => NEUTRAL.test(cls))
      .map(([service]) => service)
      .sort();
    expect(neutral).toEqual(['gateway', 'other']);
    expect(SERVICE_SWATCH.gateway.split('/')[0]).not.toBe(SERVICE_SWATCH.other.split('/')[0]);
  });
});
