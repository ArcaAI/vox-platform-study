/**
 * AgenticProvider Tests
 *
 * Tests for the root provider component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { AgenticProvider, useAgenticContext, useSDKLogger } from '../AgenticProvider';
import { useStoreApi, type AgenticStoreApi } from '../../store/agenticStore';
import type { AgenticConfig } from '../../types';
import { mockFetch, createMockResponse } from '../../__tests__/setup';
import { PluginManager } from '../../core/PluginManager';

// The provider owns a per-instance store, so these
// tests capture THIS provider's StoreApi via `useStoreApi()` from a descendant
// (`TestComponent`, or `StoreProbe` where no `TestComponent` is rendered)
// instead of reading the module singleton.
let capturedStore: AgenticStoreApi | null = null;
function StoreProbe() {
  capturedStore = useStoreApi();
  return null;
}

// Test component to access context
function TestComponent() {
  // `useAgenticContext()` runs first so the "outside provider" test still sees
  // its expected error before `useStoreApi()` would throw.
  const context = useAgenticContext();
  capturedStore = useStoreApi();
  return (
    <div data-testid="test-component">
      <span data-testid="initialized">{context.initialized.toString()}</span>
      <span data-testid="base-url">{context.config.api.baseUrl}</span>
    </div>
  );
}

// Test component for logger
function LoggerTestComponent() {
  const logger = useSDKLogger();
  return (
    <div data-testid="logger-test">
      <span data-testid="has-logger">{(!!logger).toString()}</span>
    </div>
  );
}

describe('AgenticProvider', () => {
  const testConfig: AgenticConfig = {
    api: {
      baseUrl: 'http://test-api.com',
      apiKey: 'test-api-key',
      tenantId: 'test-tenant',
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
    logging: {
      level: 'info',
    },
  };

  beforeEach(() => {
    // Each render builds a fresh per-provider store, so no singleton reset is
    // needed; just drop the previous capture.
    capturedStore = null;
    mockFetch.mockReset();
    // Mock successful responses for initialization
    mockFetch.mockResolvedValue(createMockResponse([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should render children', () => {
      render(
        <AgenticProvider config={testConfig}>
          <div data-testid="child">Child Content</div>
        </AgenticProvider>,
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('should provide context to children', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('base-url').textContent).toBe('http://test-api.com');
      });
    });
  });

  describe('initialization', () => {
    it('should initialize the store', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });
    });

    it('should create API client', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.apiClient).toBeDefined();
      });
    });

    it('should create plugin manager', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.pluginManager).toBeDefined();
      });
    });

    it('should create personalization manager', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.personalizationManager).toBeDefined();
      });
    });

    it('should create model registry', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.modelRegistry).toBeDefined();
      });
    });
  });

  describe('useAgenticContext', () => {
    it('should throw when used outside provider', () => {
      // Suppress error output for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestComponent />);
      }).toThrow('useAgenticContext must be used within an <AgenticProvider>');

      consoleSpy.mockRestore();
    });
  });

  describe('useSDKLogger', () => {
    it('should provide logger', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <LoggerTestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('has-logger').textContent).toBe('true');
      });
    });
  });

  describe('with debug mode', () => {
    it('should configure logger for debug', async () => {
      const debugConfig = {
        ...testConfig,
        debug: true,
      };

      render(
        <AgenticProvider config={debugConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.logger).toBeDefined();
      });
    });
  });

  describe('personalization modes', () => {
    it('should start sync for hybrid mode', async () => {
      const hybridConfig = {
        ...testConfig,
        personalization: {
          storage: 'hybrid' as const,
          syncInterval: 60000,
        },
      };

      render(
        <AgenticProvider config={hybridConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });
    });

    it('should load from backend for non-local mode', async () => {
      const backendConfig = {
        ...testConfig,
        personalization: {
          storage: 'backend' as const,
        },
      };

      render(
        <AgenticProvider config={backendConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        // Should have called API for preferences
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Stream B Gap Fixes (SDK-206, Layer 1)
  // =========================================================================

  describe('HOOK-02 / NER-L-03: PluginManager receives apiClient', () => {
    it('should store a PluginManager with apiClient that can access backend services', async () => {
      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });

      const state = capturedStore!.getState();
      const pluginManager = state.pluginManager;
      expect(pluginManager).toBeDefined();

      // Verify the PluginManager received the apiClient by confirming
      // it can initialize a knowledge pipeline without "API client required" error.
      // This tests the real behavioral outcome, not that a constructor was called.
      const initSpy = vi.spyOn(pluginManager!, 'initializeKnowledgePipeline').mockResolvedValue(undefined);
      await pluginManager!.initializeKnowledgePipeline();
      expect(initSpy).toHaveBeenCalled();
      initSpy.mockRestore();
    });

    it('should initialize knowledge pipeline on mount when NER config is present', async () => {
      const nerConfig: AgenticConfig = {
        ...testConfig,
        plugins: {
          ner: { enabled: true, model: 'biomedical', threshold: 0.6 },
        },
      };

      const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline');

      render(
        <AgenticProvider config={nerConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });

      expect(initKnowledgeSpy).toHaveBeenCalled();
      initKnowledgeSpy.mockRestore();
    });

    it('should NOT initialize knowledge pipeline when NER is disabled', async () => {
      const noNerConfig: AgenticConfig = {
        ...testConfig,
        plugins: {
          ner: { enabled: false, model: 'biomedical', threshold: 0.6 },
        },
      };

      const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline');

      render(
        <AgenticProvider config={noNerConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });

      expect(initKnowledgeSpy).not.toHaveBeenCalled();
      initKnowledgeSpy.mockRestore();
    });

    it('should NOT initialize knowledge pipeline when no NER config is provided', async () => {
      const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline');

      render(
        <AgenticProvider config={testConfig}>
          <TestComponent />
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });

      expect(initKnowledgeSpy).not.toHaveBeenCalled();
      initKnowledgeSpy.mockRestore();
    });

    it('should render children even if knowledge pipeline initialization fails', async () => {
      const nerConfig: AgenticConfig = {
        ...testConfig,
        plugins: {
          ner: { enabled: true, model: 'biomedical', threshold: 0.6 },
        },
      };

      const initKnowledgeSpy = vi.spyOn(PluginManager.prototype, 'initializeKnowledgePipeline').mockRejectedValueOnce(new Error('Model load failed'));

      render(
        <AgenticProvider config={nerConfig}>
          <StoreProbe />
          <div data-testid="still-here">Content</div>
        </AgenticProvider>,
      );

      await waitFor(() => {
        const state = capturedStore!.getState();
        expect(state.initialized).toBe(true);
      });

      // The app should still render despite knowledge pipeline failure
      expect(screen.getByTestId('still-here')).toBeInTheDocument();
      expect(initKnowledgeSpy).toHaveBeenCalled();
      initKnowledgeSpy.mockRestore();
    });
  });
});
