import { APP_NAME, APP_VERSION, STORAGE_KEYS } from '../constants';

describe('constants', () => {
  it("APP_NAME should be 'ArcaVox Admin Console'", () => {
    expect(APP_NAME).toBe('ArcaVox Admin Console');
  });

  it("APP_VERSION should be '0.1.0'", () => {
    expect(APP_VERSION).toBe('0.1.0');
  });

  it('STORAGE_KEYS should have AUTH key', () => {
    expect(STORAGE_KEYS).toHaveProperty('AUTH');
    expect(typeof STORAGE_KEYS.AUTH).toBe('string');
  });

  it('STORAGE_KEYS should have AUDIO_CONFIG key', () => {
    expect(STORAGE_KEYS).toHaveProperty('AUDIO_CONFIG');
    expect(typeof STORAGE_KEYS.AUDIO_CONFIG).toBe('string');
  });

  it('STORAGE_KEYS should have SIDEBAR_STATE key', () => {
    expect(STORAGE_KEYS).toHaveProperty('SIDEBAR_STATE');
    expect(typeof STORAGE_KEYS.SIDEBAR_STATE).toBe('string');
  });

  it('STORAGE_KEYS should have THEME key', () => {
    expect(STORAGE_KEYS).toHaveProperty('THEME');
    expect(typeof STORAGE_KEYS.THEME).toBe('string');
  });

  it('STORAGE_KEYS values should be unique', () => {
    const values = Object.values(STORAGE_KEYS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
