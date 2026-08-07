/**
 * @arcaai/vox - Microsoft Clarity Transport Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClarityTransport } from '../transports/clarity.transport';
import { REDACTED_VALUE } from '../redactor';
import type { LogEntry, ClarityTransportConfig } from '../types';

const mockClarity = {
  init: vi.fn(),
  setTag: vi.fn(),
  identify: vi.fn(),
  consent: vi.fn(),
  consentV2: vi.fn(),
  upgrade: vi.fn(),
  event: vi.fn(),
};

vi.mock('@microsoft/clarity', () => ({ default: mockClarity }));

describe('ClarityTransport', () => {
  let config: ClarityTransportConfig;

  const createLogEntry = (overrides?: Partial<LogEntry>): LogEntry => ({
    timestamp: Date.now(),
    timestampIso: new Date().toISOString(),
    level: 'error',
    severityNumber: 17,
    message: 'Test message',
    ...overrides,
  });

  /** Build an already-initialised transport. */
  async function makeTransport(overrides?: Partial<ClarityTransportConfig>): Promise<ClarityTransport> {
    const t = new ClarityTransport({ ...config, ...overrides });
    await t.initialize();
    return t;
  }

  beforeEach(() => {
    Object.values(mockClarity).forEach((fn) => fn.mockClear());
    // No `enabled` flag: the project ID alone is what turns Clarity on, so the
    // whole suite exercises that path.
    config = {
      projectId: 'xynejqavet',
      serviceName: 'test-service',
      environment: 'test',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('activation gate', () => {
    it('exposes the transport name "clarity"', () => {
      expect(new ClarityTransport(config).name).toBe('clarity');
    });

    it('activates with a project ID configured, outside production', () => {
      expect(ClarityTransport.isAllowedToActivate(config)).toBe(true);
    });

    // The project ID is the developer-facing on/off switch.
    describe('project ID is the switch', () => {
      it('activates on project ID alone, with no `enabled` flag', () => {
        expect(ClarityTransport.isAllowedToActivate({ projectId: 'xynejqavet', environment: 'staging' })).toBe(true);
      });

      it('stays off when no project ID is configured', () => {
        expect(ClarityTransport.isAllowedToActivate({ environment: 'staging' })).toBe(false);
      });

      it('stays off for an unset env var (undefined / empty / whitespace)', () => {
        expect(ClarityTransport.isAllowedToActivate({ ...config, projectId: undefined })).toBe(false);
        expect(ClarityTransport.isAllowedToActivate({ ...config, projectId: '' })).toBe(false);
        expect(ClarityTransport.isAllowedToActivate({ ...config, projectId: '   ' })).toBe(false);
      });

      it('stays off for an empty config object', () => {
        expect(ClarityTransport.isAllowedToActivate({})).toBe(false);
      });

      it('trims a padded project ID before initialising', async () => {
        const t = new ClarityTransport({ ...config, projectId: '  xynejqavet  ' });
        await t.initialize();
        expect(mockClarity.init).toHaveBeenCalledWith('xynejqavet');
      });
    });

    describe('`enabled` override', () => {
      it('forces the transport off even with a project ID configured', () => {
        expect(ClarityTransport.isAllowedToActivate({ ...config, enabled: false })).toBe(false);
      });

      it('is redundant but accepted when true', () => {
        expect(ClarityTransport.isAllowedToActivate({ ...config, enabled: true })).toBe(true);
      });

      it('cannot enable the transport without a project ID', () => {
        expect(ClarityTransport.isAllowedToActivate({ enabled: true, environment: 'staging' })).toBe(false);
      });
    });

    it('refuses activation in production (HIPAA fail-closed gate)', () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(ClarityTransport.isAllowedToActivate({ ...config, environment: undefined })).toBe(false);
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('refuses activation when the deployment is explicitly production', () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        expect(ClarityTransport.isAllowedToActivate({ ...config, environment: 'production' })).toBe(false);
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    // The regression that matters for staging: browser bundlers bake
    // NODE_ENV='production' into ANY optimised build, including the one
    // deployed to staging. Without the declared-environment check the
    // transport would be silently dead exactly where it is wanted.
    it('activates on a staging deploy built with NODE_ENV=production', () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(ClarityTransport.isAllowedToActivate({ ...config, environment: 'staging' })).toBe(true);
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('logs on a staging deploy built with NODE_ENV=production', async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const t = new ClarityTransport({ ...config, environment: 'staging' });
        await t.initialize();
        t.log(createLogEntry({ error: { code: 'STAGING_CHECK' } }));
        expect(mockClarity.init).toHaveBeenCalledWith('xynejqavet');
        expect(mockClarity.event).toHaveBeenCalledWith('vox.error.STAGING_CHECK');
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('never initialises or queues when permanently disabled', async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const t = new ClarityTransport({ ...config, environment: undefined });
        await t.initialize();
        t.log(createLogEntry());
        expect(mockClarity.init).not.toHaveBeenCalled();
        expect(mockClarity.event).not.toHaveBeenCalled();
        expect(mockClarity.setTag).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = original;
      }
    });
  });

  describe('initialize', () => {
    it('initialises Clarity with the configured project ID', async () => {
      await makeTransport();
      expect(mockClarity.init).toHaveBeenCalledWith('xynejqavet');
    });

    it('tags the service and environment on startup', async () => {
      await makeTransport();
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.service', 'test-service');
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.environment', 'test');
    });

    it('is idempotent across repeated initialize() calls', async () => {
      const t = await makeTransport();
      await t.initialize();
      expect(mockClarity.init).toHaveBeenCalledTimes(1);
    });

    it('starts with consent denied when requireConsent is set', async () => {
      await makeTransport({ requireConsent: true });
      expect(mockClarity.consentV2).toHaveBeenCalledWith({ ad_Storage: 'denied', analytics_Storage: 'denied' });
    });

    it('does not touch consent by default', async () => {
      await makeTransport();
      expect(mockClarity.consentV2).not.toHaveBeenCalled();
    });
  });

  describe('log levels', () => {
    it('defaults to the error floor — info entries produce no events', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ level: 'info', message: 'noise' }));
      expect(mockClarity.event).not.toHaveBeenCalled();
    });

    it('honours an explicit level floor', async () => {
      const t = await makeTransport({ level: 'info' });
      t.log(createLogEntry({ level: 'info', operation: { operation: 'startAudio', durationMs: 12 } }));
      expect(mockClarity.event).toHaveBeenCalledWith('vox.op.startAudio');
    });

    it('emits events for fatal entries', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ level: 'fatal', error: { name: 'BootError' } }));
      expect(mockClarity.event).toHaveBeenCalledWith('vox.error.BootError');
    });
  });

  describe('error reporting', () => {
    it('names the event after the error code when present', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ error: { code: 'STT_TIMEOUT', name: 'SttError' } }));
      expect(mockClarity.event).toHaveBeenCalledWith('vox.error.STT_TIMEOUT');
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.errorCode', 'STT_TIMEOUT');
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.errorName', 'SttError');
    });

    it('tags the HTTP status when the error carries one', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ error: { code: 'HTTP_ERROR' }, http: { statusCode: 503 } }));
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.httpStatus', '503');
    });

    it('sanitises unsafe characters out of event names', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ error: { code: 'weird code/with spaces!' } }));
      expect(mockClarity.event).toHaveBeenCalledWith('vox.error.weird_code_with_spaces');
    });

    it('does not upgrade the session by default', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ error: { code: 'E' } }));
      expect(mockClarity.upgrade).not.toHaveBeenCalled();
    });

    it('upgrades the session on error when opted in', async () => {
      const t = await makeTransport({ upgradeOnError: true });
      t.log(createLogEntry({ error: { code: 'E' } }));
      expect(mockClarity.upgrade).toHaveBeenCalledWith('vox.error.E');
    });
  });

  describe('PHI safety', () => {
    it('never forwards values the PHI redactor replaced', async () => {
      const t = await makeTransport({ identifyUsers: true });
      t.log(
        createLogEntry({
          user: { userId: REDACTED_VALUE, tenantId: REDACTED_VALUE },
          error: { code: REDACTED_VALUE, name: REDACTED_VALUE },
        }),
      );

      expect(mockClarity.identify).not.toHaveBeenCalled();
      const tagged = mockClarity.setTag.mock.calls.map(([, value]) => value);
      expect(tagged).not.toContain(REDACTED_VALUE);
    });

    it('does not identify users unless explicitly opted in', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ user: { userId: 'user-1' } }));
      expect(mockClarity.identify).not.toHaveBeenCalled();
    });

    it('identifies the user once when opted in', async () => {
      const t = await makeTransport({ identifyUsers: true });
      t.log(createLogEntry({ user: { userId: 'user-1' } }));
      t.log(createLogEntry({ user: { userId: 'user-1' } }));
      expect(mockClarity.identify).toHaveBeenCalledTimes(1);
      expect(mockClarity.identify).toHaveBeenCalledWith('user-1', undefined, undefined, undefined);
    });
  });

  describe('tagging', () => {
    it('sends correlation and tenant tags for cross-referencing sessions', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ correlation: { correlationId: 'corr-1' }, user: { tenantId: 'tenant-1' } }));
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.correlationId', 'corr-1');
      expect(mockClarity.setTag).toHaveBeenCalledWith('vox.tenantId', 'tenant-1');
    });

    it('does not re-send an identical tag pair', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ context: 'AgenticClient', error: { code: 'A' } }));
      t.log(createLogEntry({ context: 'AgenticClient', error: { code: 'A' } }));
      const contextTags = mockClarity.setTag.mock.calls.filter(([key]) => key === 'vox.context');
      expect(contextTags).toHaveLength(1);
    });

    it('truncates oversized tag values', async () => {
      const t = await makeTransport();
      t.log(createLogEntry({ context: 'x'.repeat(400), error: { code: 'A' } }));
      const call = mockClarity.setTag.mock.calls.find(([key]) => key === 'vox.context');
      expect(call?.[1]).toHaveLength(255);
    });
  });

  describe('queueing before initialization', () => {
    it('flushes entries logged before initialize()', async () => {
      const t = new ClarityTransport(config);
      t.log(createLogEntry({ error: { code: 'EARLY' } }));
      expect(mockClarity.event).not.toHaveBeenCalled();

      await t.initialize();
      expect(mockClarity.event).toHaveBeenCalledWith('vox.error.EARLY');
    });

    it('bounds the pending queue', async () => {
      const t = new ClarityTransport(config);
      for (let i = 0; i < 120; i++) {
        t.log(createLogEntry({ error: { code: `E${i}` } }));
      }
      await t.initialize();
      expect(mockClarity.event).toHaveBeenCalledTimes(50);
    });
  });

  describe('public helpers', () => {
    it('tracks ad-hoc events', async () => {
      const t = await makeTransport();
      t.track('checkout completed');
      expect(mockClarity.event).toHaveBeenCalledWith('checkout_completed');
    });

    it('passes consent grants through as ConsentV2', async () => {
      const t = await makeTransport();
      t.setConsent(true);
      expect(mockClarity.consentV2).toHaveBeenCalledWith({ ad_Storage: 'granted', analytics_Storage: 'granted' });
    });
  });

  describe('shutdown', () => {
    it('revokes consent and clears local state', async () => {
      const t = await makeTransport();
      await t.shutdown();
      expect(mockClarity.consentV2).toHaveBeenCalledWith({ ad_Storage: 'denied', analytics_Storage: 'denied' });

      mockClarity.event.mockClear();
      t.log(createLogEntry({ error: { code: 'AFTER' } }));
      expect(mockClarity.event).not.toHaveBeenCalled();
    });

    it('flush resolves without error', async () => {
      const t = await makeTransport();
      await expect(t.flush()).resolves.toBeUndefined();
    });
  });
});
