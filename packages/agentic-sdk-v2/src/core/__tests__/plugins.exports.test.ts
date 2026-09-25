/**
 * @arcaai/vox - Plugin Exports Tests (Stream F)
 *
 * TDD tests for plugin entry point exports.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model.
 * `useVAD`/`useSTT`/`useNoiseFilter` (gated wrappers), `useSttProviderToggle`,
 * `createProcessedAudioTap`, and the whole `./plugins/med-ner` entry were
 * removed — see task1006-removed.test.ts for the pinned absence of those
 * plus the deleted client-AI packages.
 */

import { describe, it, expect } from 'vitest';

describe('Plugin Exports', () => {
  it('should export useArcaAudio', async () => {
    const plugins = await import('../../plugins.js');
    expect(plugins).toHaveProperty('useArcaAudio');
  });

  it('should export PluginManager', async () => {
    const plugins = await import('../../plugins.js');
    expect(plugins).toHaveProperty('PluginManager');
  });

  it('should export pipeline classes', async () => {
    const plugins = await import('../../plugins.js');
    expect(plugins).toHaveProperty('TranscriptionPipeline');
    expect(plugins).toHaveProperty('KnowledgePipeline');
  });

  it('should NOT export the removed client-inference surfaces', async () => {
    const plugins = await import('../../plugins.js');
    expect(plugins).not.toHaveProperty('useVAD');
    expect(plugins).not.toHaveProperty('useSTT');
    expect(plugins).not.toHaveProperty('useNoiseFilter');
    expect(plugins).not.toHaveProperty('useMedNER');
    expect(plugins).not.toHaveProperty('useSttProviderToggle');
    expect(plugins).not.toHaveProperty('createProcessedAudioTap');
  });
});
