import { describe, expect, it } from 'vitest';
import type { GlobalSetting } from '@arcaai/vox';
import {
  groupByNamespace,
  hasDefaultValue,
  isSecretSetting,
  isSettingLocked,
  namespaceLabel,
  prettyJson,
  settingControlKind,
  settingDefaultValue,
  stringifyForInput,
} from '../global-settings';

const setting = (key: string, namespace?: string, extra: Partial<GlobalSetting> = {}): GlobalSetting =>
  ({ id: key, key, value: null, namespace, ...extra }) as GlobalSetting;

describe('isSettingLocked (TASK-391 #24)', () => {
  it('is true only when the server flags locked === true', () => {
    expect(isSettingLocked({ locked: true })).toBe(true);
    expect(isSettingLocked({ locked: false })).toBe(false);
    expect(isSettingLocked({})).toBe(false);
    expect(isSettingLocked(null)).toBe(false);
    expect(isSettingLocked(undefined)).toBe(false);
  });

  it('does not treat truthy-but-not-true values as locked', () => {
    expect(isSettingLocked({ locked: 'yes' as unknown as boolean })).toBe(false);
    expect(isSettingLocked({ locked: 1 as unknown as boolean })).toBe(false);
  });
});

describe('namespaceLabel (TASK-391 #24)', () => {
  it('maps known namespaces to pretty labels', () => {
    expect(namespaceLabel('feature-flags')).toBe('Feature flags');
    expect(namespaceLabel('stt')).toBe('STT');
    expect(namespaceLabel('ux-constants')).toBe('UX constants');
  });

  it('renders unknown namespaces verbatim and empty as "Other"', () => {
    expect(namespaceLabel('custom-ns')).toBe('custom-ns');
    expect(namespaceLabel('')).toBe('Other');
    expect(namespaceLabel(undefined)).toBe('Other');
  });
});

describe('groupByNamespace (TASK-391 #24)', () => {
  it('orders groups by the canonical section order', () => {
    const groups = groupByNamespace([setting('a', 'admin'), setting('b', 'general'), setting('c', 'smr')]);
    expect(groups.map((g) => g.key)).toEqual(['general', 'smr', 'admin']);
  });

  it('places unknown namespaces after known ones and ungrouped last', () => {
    const groups = groupByNamespace([setting('x'), setting('y', 'zeta-custom'), setting('z', 'general')]);
    expect(groups.map((g) => g.key)).toEqual(['general', 'zeta-custom', '']);
    expect(groups.at(-1)?.label).toBe('Other');
  });

  it('buckets settings under their namespace, preserving input order within a group', () => {
    const groups = groupByNamespace([setting('flag-a', 'feature-flags'), setting('flag-b', 'feature-flags')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].settings.map((s) => s.key)).toEqual(['flag-a', 'flag-b']);
    expect(groups[0].label).toBe('Feature flags');
  });
});

describe('settingControlKind (TASK-395 P1-4)', () => {
  it('maps Boolean dataTypes to a toggle', () => {
    expect(settingControlKind(setting('f', 'feature-flags', { dataType: 'Boolean' }))).toBe('boolean');
    expect(settingControlKind(setting('f', 'feature-flags', { dataType: 'bool' }))).toBe('boolean');
  });

  it('maps numeric dataTypes to a number input', () => {
    for (const t of ['Integer', 'Int', 'Float', 'Double', 'Decimal', 'Number']) {
      expect(settingControlKind(setting('n', 'general', { dataType: t }))).toBe('number');
    }
  });

  it('maps Json/Array/Object dataTypes to a code affordance', () => {
    expect(settingControlKind(setting('j', 'stt', { dataType: 'Json' }))).toBe('json');
    expect(settingControlKind(setting('j', 'stt', { dataType: 'Array' }))).toBe('json');
  });

  it('falls back to a text input for String/DateTime/unknown/absent types', () => {
    expect(settingControlKind(setting('s', 'general', { dataType: 'String' }))).toBe('string');
    expect(settingControlKind(setting('s', 'general', { dataType: 'DateTime' }))).toBe('string');
    expect(settingControlKind(setting('s', 'general', { dataType: 'weird' }))).toBe('string');
    expect(settingControlKind(setting('s', 'general'))).toBe('string');
    expect(settingControlKind(null)).toBe('string');
    expect(settingControlKind(undefined)).toBe('string');
  });
});

describe('isSecretSetting (TASK-395 P1-4)', () => {
  it('is true only when a non-empty encryptedValue marker is present', () => {
    expect(isSecretSetting({ encryptedValue: 'vault://x' })).toBe(true);
    expect(isSecretSetting({ encryptedValue: true })).toBe(true);
    expect(isSecretSetting({ encryptedValue: '' })).toBe(false);
    expect(isSecretSetting({ encryptedValue: '   ' })).toBe(false);
    expect(isSecretSetting({ encryptedValue: null })).toBe(false);
    expect(isSecretSetting({ encryptedValue: false })).toBe(false);
    expect(isSecretSetting({})).toBe(false);
    expect(isSecretSetting(null)).toBe(false);
  });
});

describe('hasDefaultValue / settingDefaultValue (TASK-395 P1-4)', () => {
  it('detects and reads a server defaultValue', () => {
    expect(hasDefaultValue({ defaultValue: 10 })).toBe(true);
    expect(hasDefaultValue({ defaultValue: false })).toBe(true);
    expect(hasDefaultValue({ defaultValue: null })).toBe(false);
    expect(hasDefaultValue({})).toBe(false);
    expect(hasDefaultValue(null)).toBe(false);
    expect(settingDefaultValue({ defaultValue: 'en' })).toBe('en');
    expect(settingDefaultValue({})).toBeUndefined();
    expect(settingDefaultValue(null)).toBeUndefined();
  });
});

describe('stringifyForInput / prettyJson (TASK-395 P1-4)', () => {
  it('stringifies scalars for text/number inputs; nullish → empty string', () => {
    expect(stringifyForInput(null)).toBe('');
    expect(stringifyForInput(undefined)).toBe('');
    expect(stringifyForInput('en')).toBe('en');
    expect(stringifyForInput(10)).toBe('10');
    expect(stringifyForInput(true)).toBe('true');
    expect(stringifyForInput({ a: 1 })).toBe('{"a":1}');
  });

  it('pretty-prints JSON with 2-space indentation for the expandable view', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(['x', 'y'])).toBe('[\n  "x",\n  "y"\n]');
  });
});
