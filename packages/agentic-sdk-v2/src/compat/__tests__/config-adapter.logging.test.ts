/**
 * @arcaai/vox/compat - observability passthrough in the v1 config adapter
 * @vitest-environment jsdom
 *
 * The defect these lock down: the adapter used to emit NO `logging` key, so
 * `cfg.logging?.clarity` was always undefined inside `AgenticProvider` and a
 * compat app could not enable Clarity/Highlight/Loki/OTel by any means.
 */

import { describe, it, expect } from 'vitest';
import { mapV1ConfigToAgenticConfig } from '../config-adapter';
import { ClarityTransport } from '../../core/logger/transports/clarity.transport';
import type { V1SdkConfig } from '../types';

const baseConfig: V1SdkConfig = {
  apiEndpoint: 'https://api.arcaai.com',
  websocketUrl: 'wss://api.arcaai.com',
  credentials: { apiKey: 'tenant-key-123' },
};

describe('mapV1ConfigToAgenticConfig — observability', () => {
  describe('passthrough', () => {
    it('emits no `logging` key at all when the v1 config omits it', () => {
      const cfg = mapV1ConfigToAgenticConfig(baseConfig);
      expect('logging' in cfg).toBe(false);
    });

    it('forwards the logging block to the v2 config', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        logging: { clarity: { projectId: 'xynejqavet' } },
      });
      expect(cfg.logging?.clarity?.projectId).toBe('xynejqavet');
    });

    it('forwards the browser capture block untouched', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        logging: { capture: { console: true, consoleMethods: ['log', 'warn', 'error'] } },
      });
      expect(cfg.logging?.capture).toEqual({ console: true, consoleMethods: ['log', 'warn', 'error'] });
    });

    it('forwards transports the adapter does not special-case', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'staging',
        logging: { level: 'debug', loki: { enabled: true, url: 'https://loki.internal' } },
      });
      expect(cfg.logging?.level).toBe('debug');
      expect(cfg.logging?.loki).toEqual({ enabled: true, url: 'https://loki.internal' });
    });
  });

  describe('deployment stage propagation', () => {
    it('defaults the Clarity environment from the v1 `environment`', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'staging',
        logging: { clarity: { projectId: 'xynejqavet' } },
      });
      expect(cfg.logging?.clarity?.environment).toBe('staging');
    });

    it('defaults the Highlight environment from the v1 `environment`', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'staging',
        logging: { highlight: { enabled: true, projectId: 'hl-1' } },
      });
      expect(cfg.logging?.highlight?.environment).toBe('staging');
    });

    it('lets an explicit transport environment win', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'production',
        logging: { clarity: { projectId: 'xynejqavet', environment: 'staging' } },
      });
      expect(cfg.logging?.clarity?.environment).toBe('staging');
    });

    it('leaves the block alone when the v1 config declares no environment', () => {
      const logging = { clarity: { projectId: 'xynejqavet' } };
      const cfg = mapV1ConfigToAgenticConfig({ ...baseConfig, logging });
      expect(cfg.logging?.clarity?.environment).toBeUndefined();
    });

    it('does not invent transports that were not configured', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'staging',
        logging: { clarity: { projectId: 'xynejqavet' } },
      });
      expect(cfg.logging?.highlight).toBeUndefined();
    });
  });

  /**
   * End-to-end: the adapter output must actually clear the transport gate.
   * NODE_ENV is forced to 'production' because that is what a staging BUILD
   * looks like — the exact condition that silently disabled the transport
   * before the stage was propagated.
   */
  describe('end-to-end activation from a compat config', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const withProductionBuild = (fn: () => void) => {
      process.env.NODE_ENV = 'production';
      try {
        fn();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    };

    it('activates Clarity for a staging compat app built with NODE_ENV=production', () => {
      withProductionBuild(() => {
        const cfg = mapV1ConfigToAgenticConfig({
          ...baseConfig,
          environment: 'staging',
          logging: { clarity: { projectId: 'xynejqavet' } },
        });
        expect(ClarityTransport.isAllowedToActivate(cfg.logging!.clarity!)).toBe(true);
      });
    });

    it('keeps Clarity off for a production compat app', () => {
      withProductionBuild(() => {
        const cfg = mapV1ConfigToAgenticConfig({
          ...baseConfig,
          environment: 'production',
          logging: { clarity: { projectId: 'xynejqavet' } },
        });
        expect(ClarityTransport.isAllowedToActivate(cfg.logging!.clarity!)).toBe(false);
      });
    });

    it('keeps Clarity off when no project ID is configured', () => {
      const cfg = mapV1ConfigToAgenticConfig({
        ...baseConfig,
        environment: 'staging',
        logging: { clarity: {} },
      });
      expect(ClarityTransport.isAllowedToActivate(cfg.logging!.clarity!)).toBe(false);
    });
  });
});
