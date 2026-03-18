/**
 * @arcaai/vox - Plugin Exports Tests (Stream F)
 *
 * TDD tests for plugin entry point exports.
 * useMedNER has been moved to a separate entry point (@arcaai/vox/plugins/med-ner)
 * to prevent the main plugins module from failing when @arcaai/med-ner is not installed.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@arcaai/vad', () => ({
  useVAD: vi.fn(),
}));

vi.mock('@arcaai/stt', () => ({
  useSTT: vi.fn(),
}));

vi.mock('@arcaai/noise-filter', () => ({
  useNoiseFilter: vi.fn(),
}));

describe('Plugin Exports', () => {
  it('should export useVAD', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).toHaveProperty('useVAD');
  });

  it('should export useSTT', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).toHaveProperty('useSTT');
  });

  it('should export useNoiseFilter', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).toHaveProperty('useNoiseFilter');
  });

  it('should export PluginManager', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).toHaveProperty('PluginManager');
  });

  it('should export pipeline classes', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).toHaveProperty('TranscriptionPipeline');
    expect(plugins).toHaveProperty('KnowledgePipeline');
  });

  it('should NOT export useMedNER (moved to plugins/med-ner)', async () => {
    const plugins = await import('../../plugins');
    expect(plugins).not.toHaveProperty('useMedNER');
  });
});
