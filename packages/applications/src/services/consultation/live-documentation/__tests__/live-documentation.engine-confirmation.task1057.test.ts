/** TASK-1057 — `harnessLiveConfig.update`: the engine kill-switch write consults the reason policy. */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import { ActionConfirmationService } from '../../../settings-registry/action-confirmation.service';

function build(mode: 'required' | 'not-required') {
  const svc = Object.create(LiveDocumentationService.prototype) as Record<string, unknown>;
  const cacheService = { set: vi.fn(async () => undefined) };
  const warn = vi.fn();
  Object.assign(svc, {
    cacheService,
    logger: { warn },
    CONFIG_ENABLED_KEY: 'k',
    CONFIG_CONTROL_CHANNEL: 'c',
    enabled: true,
    safeChannelPublish: vi.fn(async () => undefined),
    confirmations: new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never),
  });
  return { svc: svc as unknown as LiveDocumentationService, cacheService, warn };
}

describe('LiveDocumentationService.setEngineEnabled — action confirmation (TASK-1057)', () => {
  it('passes without a reason by default and records the stamp on the persisted record', async () => {
    const { svc, cacheService, warn } = build('not-required');
    await svc.setEngineEnabled(false, { userId: 'u1' });
    const record = JSON.parse((cacheService.set.mock.calls[0] as unknown as string[])[1]);
    expect(record.confirmation).toMatchObject({ actionId: 'harnessLiveConfig.update', required: false, note: 'reason not required' });
    expect(JSON.stringify(warn.mock.calls)).toContain('reason not required');
  });

  it('refuses 400 CONFIRMATION_REQUIRED before writing when required and missing', async () => {
    const { svc, cacheService } = build('required');
    await expect(svc.setEngineEnabled(false, { userId: 'u1' })).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'harnessLiveConfig.update' },
    });
    expect(cacheService.set).not.toHaveBeenCalled();
  });
});
