/**
 * (supporting backend change) — user-settings namespace registry.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  USER_SETTINGS_NAMESPACES,
  KNOWN_USER_SETTINGS_NAMESPACES,
  isKnownUserSettingsNamespace,
  UI_DATA_GRID_MAX_BYTES,
  validateUiDataGridValue,
} from '../userSettings.namespaces';

describe('user-settings namespace registry', () => {
  it('registers ui.data-grid alongside the existing SDK and admin namespaces', () => {
    expect(USER_SETTINGS_NAMESPACES.UI_DATA_GRID).toBe('ui.data-grid');
    expect(USER_SETTINGS_NAMESPACES.SDK).toBe('arcaai-sdk');
    expect(USER_SETTINGS_NAMESPACES.ADMIN).toBe('arcaai-admin');
  });

  it('recognises the registered namespaces and rejects unknown ones', () => {
    expect(isKnownUserSettingsNamespace('ui.data-grid')).toBe(true);
    expect(isKnownUserSettingsNamespace('arcaai-sdk')).toBe(true);
    expect(isKnownUserSettingsNamespace('arcaai-admin')).toBe(true);
    expect(isKnownUserSettingsNamespace('something-else')).toBe(false);
    expect(KNOWN_USER_SETTINGS_NAMESPACES.has('ui.data-grid')).toBe(true);
  });

  it('exposes a positive byte cap for ui.data-grid values', () => {
    expect(UI_DATA_GRID_MAX_BYTES).toBeGreaterThan(0);
  });
});

// (item 1 backend) — the `ui.data-grid` round-trip guard is now a
// single shared validator so BOTH the self-service controller and the service
// layer (used by the admin path) enforce the same JSON + byte-cap contract.
describe('validateUiDataGridValue', () => {
  it('accepts a valid small JSON layout value', () => {
    const layout = JSON.stringify({ columnOrder: ['a', 'b'], density: 'compact' });
    expect(() => validateUiDataGridValue(layout)).not.toThrow();
  });

  it('rejects a non-JSON value with BadRequestException', () => {
    expect(() => validateUiDataGridValue('not-json{')).toThrow(BadRequestException);
  });

  it('rejects a value exceeding the byte cap with BadRequestException', () => {
    const huge = JSON.stringify({ blob: 'x'.repeat(UI_DATA_GRID_MAX_BYTES + 1) });
    expect(() => validateUiDataGridValue(huge)).toThrow(BadRequestException);
  });
});
