/**
 * TASK-1057 lane A — the action-confirmation routes are thin: pin delegation, the cell mapping
 * (null = reset survives), and that the static routes are declared (so they beat `admin/settings/:id`).
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { ActionConfirmationService } from '@arcaai/applications';
import { SettingsActionConfirmationsController } from '../settings-action-confirmations.controller';

function make() {
  const service = {
    effective: vi.fn(() => [{ actionId: 'promptTemplate.update', kind: 'reason', mode: 'required', locked: false }]),
    readPlatform: vi.fn(async () => [{ actionId: 'promptTemplate.update' }]),
    applyPlatform: vi.fn(async () => ({ rows: [], errors: [] })),
  } as unknown as ActionConfirmationService;
  return { controller: new SettingsActionConfirmationsController(service), service };
}

describe('SettingsActionConfirmationsController', () => {
  it('serves effective values synchronously from the service', () => {
    const { controller, service } = make();
    expect(controller.getEffective().items).toHaveLength(1);
    expect(service.effective).toHaveBeenCalled();
  });

  it('wraps the platform read in { items }', async () => {
    const { controller } = make();
    expect(await controller.getPlatform()).toEqual({ items: [{ actionId: 'promptTemplate.update' }] });
  });

  it('maps cells, keeping null (reset) and omitting an absent expectedVersion', async () => {
    const { controller, service } = make();
    await controller.putPlatform({
      cells: [
        { actionId: 'a', mode: null },
        { actionId: 'b', mode: 'required', expectedVersion: 3 },
      ],
    });
    expect(service.applyPlatform).toHaveBeenCalledWith([
      { actionId: 'a', mode: null },
      { actionId: 'b', mode: 'required', expectedVersion: 3 },
    ]);
  });

  it('declares the static paths under admin/settings', () => {
    expect(Reflect.getMetadata('path', SettingsActionConfirmationsController)).toBe('admin/settings');
    const proto = SettingsActionConfirmationsController.prototype;
    expect(Reflect.getMetadata('path', proto.getEffective)).toBe('action-confirmations/effective');
    expect(Reflect.getMetadata('path', proto.getPlatform)).toBe('action-confirmations');
    expect(Reflect.getMetadata('path', proto.putPlatform)).toBe('action-confirmations');
  });
});
