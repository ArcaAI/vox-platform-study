/**
 * @arcaai/vox/plugins/med-ner - Separate Entry Point Tests
 *
 * Tests that the optional med-ner hook is exported from its own entry point,
 * NOT from the main plugins entry point. This prevents the entire plugins
 * module from crashing when @arcaai/med-ner is not installed.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@arcaai/med-ner', () => ({
  useMedNER: vi.fn(),
}));

describe('plugins/med-ner entry point', () => {
  it('should export useMedNER from the dedicated entry point', async () => {
    const medNerPlugins = await import('../../plugins-med-ner.js');
    expect(medNerPlugins).toHaveProperty('useMedNER');
    expect(typeof medNerPlugins.useMedNER).toBe('function');
  });
});

describe('plugins entry point (med-ner isolation)', () => {
  it('should NOT export useMedNER from the main plugins entry point', async () => {
    const plugins = await import('../../plugins.js');
    expect(plugins).not.toHaveProperty('useMedNER');
  });
});
