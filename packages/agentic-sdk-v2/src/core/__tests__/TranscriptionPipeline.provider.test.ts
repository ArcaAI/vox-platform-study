/**
 * @arcaai/vox - TranscriptionPipeline Provider Info Tests (Stream F)
 *
 * TDD tests for F3: ASR-L-03 — Expose selected STT provider info
 */

import { describe, it, expect, vi } from 'vitest';
import { TranscriptionPipeline } from '../TranscriptionPipeline';

// Mock the external packages
vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    processedTrack: null,
    isEnabled: () => true,
    enable: vi.fn(),
    disable: vi.fn(),
  })),
}));

describe('TranscriptionPipeline: Provider Info (ASR-L-03)', () => {
  it('should expose selectedProvider property reflecting config', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'browser', provider: 'local' },
    });

    expect(pipeline.selectedProvider).toBe('local');
  });

  it('should return "auto" when provider is auto', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto' },
    });

    expect(pipeline.selectedProvider).toBe('auto');
  });

  it('should return "backend" when provider is backend', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'backend', provider: 'backend' },
    });

    expect(pipeline.selectedProvider).toBe('backend');
  });

  it('should return "auto" when no provider specified (default)', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto' },
    });

    expect(pipeline.selectedProvider).toBe('auto');
  });

  it('should update selectedProvider after updateConfig', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto' },
    });

    expect(pipeline.selectedProvider).toBe('auto');

    pipeline.updateConfig({
      stt: { enabled: true, location: 'backend', provider: 'backend' },
    });

    expect(pipeline.selectedProvider).toBe('backend');
  });

  it('should expose sttLocation reflecting config location', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'browser', provider: 'local' },
    });

    expect(pipeline.sttLocation).toBe('browser');
  });

  it('should update sttLocation after updateConfig', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'browser', provider: 'local' },
    });

    expect(pipeline.sttLocation).toBe('browser');

    pipeline.updateConfig({
      stt: { enabled: true, location: 'backend', provider: 'backend' },
    });

    expect(pipeline.sttLocation).toBe('backend');
  });

  it('should return "auto" for sttLocation when location is auto', () => {
    const pipeline = new TranscriptionPipeline({
      noiseFilter: { enabled: false, location: 'skip' },
      vad: { enabled: false, location: 'browser' },
      stt: { enabled: true, location: 'auto', provider: 'auto' },
    });

    expect(pipeline.sttLocation).toBe('auto');
  });
});
