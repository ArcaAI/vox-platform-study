/**
 * AgenticProvider NER Config Placement Tests
 *
 * Verifies that NER config is read from `config.plugins.ner` (PluginConfig),
 * NOT from `config.audio.ner` (AudioPluginConfig doesn't define ner).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { AgenticProvider } from '../AgenticProvider';
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig } from '../../types';
import { mockFetch, createMockResponse } from '../../__tests__/setup';
import { PluginManager } from '../../core/PluginManager';

// TASK-317 W4.2/W4.3 (AC-12) — the provider owns a per-instance store, so tests
// capture THIS provider's StoreApi via `useStoreApi()` from a child instead of
// reading the module singleton.
let capturedStore: AgenticStoreApi | null = null;
function StoreProbe() {
  capturedStore = useStoreApi();
  return null;
}

describe('AgenticProvider NER config placement', () => {
  const baseConfig: AgenticConfig = {
    api: {
      baseUrl: 'http://test-api.com',
      apiKey: 'test-api-key',
    },
    audio: {
      noiseFilter: false,
      vad: false,
      stt: false,
    },
    personalization: {
      storage: 'local',
      defaults: { language: 'en' },
    },
  };

  beforeEach(() => {
    // Each render builds a fresh per-provider store, so no singleton reset is
    // needed; just drop the previous capture.
    capturedStore = null;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(createMockResponse([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize knowledge pipeline when NER is in config.plugins.ner', async () => {
    const configWithPluginsNer: AgenticConfig = {
      ...baseConfig,
      plugins: {
        ner: { enabled: true, model: 'biomedical', threshold: 0.6 },
      },
    };

    const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline')
      .mockResolvedValueOnce(undefined);
    const setNERConfigSpy = vi.spyOn(PluginManager.prototype, 'setNERConfig');

    render(
      <AgenticProvider config={configWithPluginsNer}>
        <StoreProbe />
        <div>Test</div>
      </AgenticProvider>
    );

    await waitFor(() => {
      expect(capturedStore!.getState().initialized).toBe(true);
    });

    expect(setNERConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, model: 'biomedical' })
    );
    expect(initKnowledgeSpy).toHaveBeenCalled();

    initKnowledgeSpy.mockRestore();
    setNERConfigSpy.mockRestore();
  });

  it('should NOT initialize knowledge pipeline when config.plugins is absent', async () => {
    const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline');

    render(
      <AgenticProvider config={baseConfig}>
        <StoreProbe />
        <div>Test</div>
      </AgenticProvider>
    );

    await waitFor(() => {
      expect(capturedStore!.getState().initialized).toBe(true);
    });

    expect(initKnowledgeSpy).not.toHaveBeenCalled();
    initKnowledgeSpy.mockRestore();
  });

  it('should NOT initialize knowledge pipeline when config.plugins.ner.enabled is false', async () => {
    const configWithDisabledNer: AgenticConfig = {
      ...baseConfig,
      plugins: {
        ner: { enabled: false },
      },
    };

    const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline');

    render(
      <AgenticProvider config={configWithDisabledNer}>
        <StoreProbe />
        <div>Test</div>
      </AgenticProvider>
    );

    await waitFor(() => {
      expect(capturedStore!.getState().initialized).toBe(true);
    });

    expect(initKnowledgeSpy).not.toHaveBeenCalled();
    initKnowledgeSpy.mockRestore();
  });
});
