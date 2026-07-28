/**
 * @arcaai/room - Browser Compatibility Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  detectBrowserName,
  detectBrowserVersion,
  meetsMinimumVersion,
  getBrowserCapabilities,
  getBrowserLimitations,
} from '../utils/browserCompatibility.js';

const UA = {
  chrome120: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chrome90: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36',
  edge120: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefox121: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefox110: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:110.0) Gecko/20100101 Firefox/110.0',
  safari17_4: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  safari16_0: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
  iosSafari17:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iosSafari16_4:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  unknown: 'SomeBot/1.0',
};

describe('detectBrowserName', () => {
  it('should detect Chrome', () => {
    expect(detectBrowserName(UA.chrome120)).toBe('chrome');
  });

  it('should detect Edge', () => {
    expect(detectBrowserName(UA.edge120)).toBe('edge');
  });

  it('should detect Firefox', () => {
    expect(detectBrowserName(UA.firefox121)).toBe('firefox');
  });

  it('should detect Safari', () => {
    expect(detectBrowserName(UA.safari17_4)).toBe('safari');
  });

  it('should detect iOS Safari', () => {
    expect(detectBrowserName(UA.iosSafari17)).toBe('ios-safari');
  });

  it('should return unknown for unrecognized UA', () => {
    expect(detectBrowserName(UA.unknown)).toBe('unknown');
  });
});

describe('detectBrowserVersion', () => {
  it('should extract Chrome version', () => {
    expect(detectBrowserVersion('chrome', UA.chrome120)).toBe('120.0');
  });

  it('should extract Edge version', () => {
    expect(detectBrowserVersion('edge', UA.edge120)).toBe('120.0');
  });

  it('should extract Firefox version', () => {
    expect(detectBrowserVersion('firefox', UA.firefox121)).toBe('121.0');
  });

  it('should extract Safari version', () => {
    expect(detectBrowserVersion('safari', UA.safari17_4)).toBe('17.4');
  });

  it('should extract iOS Safari version', () => {
    expect(detectBrowserVersion('ios-safari', UA.iosSafari17)).toBe('17.0');
  });

  it('should return 0 for unknown browser', () => {
    expect(detectBrowserVersion('unknown', UA.unknown)).toBe('0');
  });
});

describe('meetsMinimumVersion', () => {
  it('should accept Chrome 120 (min 91)', () => {
    expect(meetsMinimumVersion('chrome', '120.0')).toBe(true);
  });

  it('should reject Chrome 90 (min 91)', () => {
    expect(meetsMinimumVersion('chrome', '90.0')).toBe(false);
  });

  it('should accept Firefox 121 (min 120)', () => {
    expect(meetsMinimumVersion('firefox', '121.0')).toBe(true);
  });

  it('should reject Firefox 110 (min 120)', () => {
    expect(meetsMinimumVersion('firefox', '110.0')).toBe(false);
  });

  it('should accept Safari 17.4 (min 16.4)', () => {
    expect(meetsMinimumVersion('safari', '17.4')).toBe(true);
  });

  it('should accept Safari 16.4 exactly', () => {
    expect(meetsMinimumVersion('safari', '16.4')).toBe(true);
  });

  it('should reject unknown browser', () => {
    expect(meetsMinimumVersion('unknown', '999.0')).toBe(false);
  });
});

describe('getBrowserCapabilities', () => {
  it('should return capabilities for Chrome', () => {
    const caps = getBrowserCapabilities(UA.chrome120);
    expect(caps.browserName).toBe('chrome');
    expect(caps.isSupported).toBe(true);
    expect(caps.supportsMultipleMics).toBe(true);
    expect(caps.supportsPersistentPermissions).toBe(true);
    expect(caps.supportsBackgroundAudio).toBe(true);
    expect(caps.recommendedSampleRate).toBe(48000);
  });

  it('should return capabilities for Firefox with no multi-mic', () => {
    const caps = getBrowserCapabilities(UA.firefox121);
    expect(caps.browserName).toBe('firefox');
    expect(caps.isSupported).toBe(true);
    expect(caps.supportsMultipleMics).toBe(false);
    expect(caps.supportsPersistentPermissions).toBe(true);
  });

  it('should return capabilities for Safari with no persistent permissions', () => {
    const caps = getBrowserCapabilities(UA.safari17_4);
    expect(caps.browserName).toBe('safari');
    expect(caps.isSupported).toBe(true);
    expect(caps.supportsPersistentPermissions).toBe(false);
    expect(caps.recommendedSampleRate).toBe(48000);
  });

  it('should return capabilities for iOS Safari with limited features', () => {
    const caps = getBrowserCapabilities(UA.iosSafari17);
    expect(caps.browserName).toBe('ios-safari');
    expect(caps.isSupported).toBe(true);
    expect(caps.supportsBackgroundAudio).toBe(false);
    expect(caps.supportsPersistentPermissions).toBe(false);
    expect(caps.audioWorkletReliable).toBe(false);
  });

  it('should mark unsupported browser', () => {
    const caps = getBrowserCapabilities(UA.unknown);
    expect(caps.isSupported).toBe(false);
  });

  it('should mark old Chrome as unsupported', () => {
    const caps = getBrowserCapabilities(UA.chrome90);
    expect(caps.isSupported).toBe(false);
  });
});

describe('getBrowserLimitations', () => {
  it('should return blocker for unsupported browser', () => {
    const caps = getBrowserCapabilities(UA.unknown);
    const limitations = getBrowserLimitations(caps);
    expect(limitations.some((l) => l.severity === 'blocker')).toBe(true);
  });

  it('should return multi-mic degraded for Firefox', () => {
    const caps = getBrowserCapabilities(UA.firefox121);
    const limitations = getBrowserLimitations(caps);
    expect(limitations.some((l) => l.feature === 'multiple-microphones')).toBe(true);
  });

  it('should return AudioWorklet degraded for iOS Safari 17', () => {
    const caps = getBrowserCapabilities(UA.iosSafari17);
    const limitations = getBrowserLimitations(caps);
    expect(limitations.some((l) => l.feature === 'audio-worklet')).toBe(true);
  });

  it('should return background-audio degraded for iOS Safari', () => {
    const caps = getBrowserCapabilities(UA.iosSafari17);
    const limitations = getBrowserLimitations(caps);
    expect(limitations.some((l) => l.feature === 'background-audio')).toBe(true);
  });

  it('should return persistent-permissions info for Safari', () => {
    const caps = getBrowserCapabilities(UA.safari17_4);
    const limitations = getBrowserLimitations(caps);
    expect(limitations.some((l) => l.feature === 'persistent-permissions')).toBe(true);
  });

  it('should return empty for fully supported Chrome', () => {
    const caps = getBrowserCapabilities(UA.chrome120);
    const capsWithSab = { ...caps, supportsSharedArrayBuffer: true };
    const limitations = getBrowserLimitations(capsWithSab);
    expect(limitations).toHaveLength(0);
  });
});
