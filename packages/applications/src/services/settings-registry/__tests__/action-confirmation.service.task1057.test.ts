/**
 * TASK-1057 — the action-confirmation policy: platform-only resolution, locked rows, the
 * `when-risky` mode, the 400 refusal, and an audit stamp that records "not required" too.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ACTION_CONFIRMATION_CATALOGUE } from '@arcaai/types';
import { ActionConfirmationService } from '../action-confirmation.service';
import { ACTION_CONFIRMATION_KEYS, ACTION_CONFIRMATION_SETTINGS } from '../descriptors/action-confirmation.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

function makeService(stored: Record<string, unknown> = {}) {
  const resolve = vi.fn((key: string, tenantId: string | null) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
    return { key, value: key in stored ? stored[key] : descriptor.default, source: key in stored ? 'system' : 'code-default', tenantId };
  });
  return { service: new ActionConfirmationService({ resolve } as never, {} as never, {} as never, {} as never), resolve };
}

describe('action-confirmation descriptors', () => {
  it('declares one platform-only key per UNLOCKED catalogue row and none for locked rows', () => {
    const unlocked = ACTION_CONFIRMATION_CATALOGUE.filter((s) => !s.locked);
    expect(ACTION_CONFIRMATION_KEYS).toEqual(unlocked.map((s) => `confirmation.${s.actionId}`));
    for (const d of ACTION_CONFIRMATION_SETTINGS) {
      expect(d.maxScope).toBe('system');
      expect(d.globalOnly).toBe(true);
      expect(HOPE_SETTINGS_REGISTRY.get(d.key)).toBeDefined();
    }
    expect(HOPE_SETTINGS_REGISTRY.get('confirmation.impersonation.start')).toBeUndefined();
    expect(HOPE_SETTINGS_REGISTRY.get('confirmation.rbac.breakGlass')).toBeUndefined();
  });

  it('rejects a mode the row does not allow', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow('confirmation.promptTemplate.update');
    expect(d.validate?.('when-risky')).toMatch(/Must be one of/);
    expect(d.validate?.('required')).toBeUndefined();
  });

  it('has unique action ids, and locked rows hold exactly one mode', () => {
    const ids = ACTION_CONFIRMATION_CATALOGUE.map((s) => s.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ACTION_CONFIRMATION_CATALOGUE.filter((x) => x.locked)) expect(s.modes).toEqual(['required']);
    for (const s of ACTION_CONFIRMATION_CATALOGUE) expect(s.modes).toContain(s.default);
  });
});

describe('ActionConfirmationService', () => {
  it('resolves on the PLATFORM lane only', () => {
    const { service, resolve } = makeService();
    service.mode('promptTemplate.update');
    expect(resolve).toHaveBeenCalledWith('confirmation.promptTemplate.update', null);
  });

  it('defaults to today’s behaviour', () => {
    const { service } = makeService();
    expect(service.mode('promptTemplate.update')).toBe('not-required');
    expect(service.mode('agent.promoteToSystem')).toBe('required');
    expect(service.mode('modelResidency.unload')).toBe('when-risky');
  });

  it('locked rows are always required, whatever is stored', () => {
    const { service, resolve } = makeService();
    expect(service.mode('impersonation.start')).toBe('required');
    expect(resolve).not.toHaveBeenCalled();
    expect(() => service.assert('impersonation.start', { value: '  ' })).toThrow(BadRequestException);
  });

  it('stamps "reason not required" when the switch is off', () => {
    const { service } = makeService({ 'confirmation.agent.promoteToSystem': 'not-required' });
    expect(service.assert('agent.promoteToSystem', {})).toEqual({
      actionId: 'agent.promoteToSystem',
      kind: 'reason',
      mode: 'not-required',
      locked: false,
      required: false,
      provided: false,
      note: 'reason not required',
    });
  });

  it('refuses 400 CONFIRMATION_REQUIRED when switched on and missing', () => {
    const { service } = makeService({ 'confirmation.promptTemplate.update': 'required' });
    try {
      service.assert('promptTemplate.update', { value: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'promptTemplate.update', kind: 'reason' });
    }
    expect(service.assert('promptTemplate.update', { value: 'fix typo' }).provided).toBe(true);
  });

  it('enforces minLength', () => {
    const { service } = makeService();
    expect(() => service.assert('tenantCheckpoint.restore', { value: 'short' })).toThrow(BadRequestException);
    expect(service.assert('tenantCheckpoint.restore', { value: 'a long enough reason' }).required).toBe(true);
  });

  it('when-risky requires only when the risk rule fired', () => {
    const { service } = makeService();
    expect(service.decide('modelResidency.unload', { risky: false }).required).toBe(false);
    expect(service.decide('modelResidency.unload', { risky: true }).required).toBe(true);
    expect(() => service.assert('modelResidency.unload', { risky: true })).toThrow(BadRequestException);
  });

  it('treats an acknowledgement as provided only when true', () => {
    const { service } = makeService();
    expect(service.decide('contextSchema.publishImpact', { value: false }).provided).toBe(false);
    expect(service.decide('contextSchema.publishImpact', { value: true }).provided).toBe(true);
  });

  it('effective() lists every catalogue row', () => {
    const { service } = makeService({ 'confirmation.tenant.delete': 'not-required' });
    const rows = service.effective();
    expect(rows).toHaveLength(ACTION_CONFIRMATION_CATALOGUE.length);
    expect(rows.find((r) => r.actionId === 'tenant.delete')).toMatchObject({ mode: 'not-required', kind: 'typeToConfirm', locked: false });
    expect(rows.find((r) => r.actionId === 'rbac.breakGlass')).toMatchObject({ mode: 'required', locked: true });
  });
});
