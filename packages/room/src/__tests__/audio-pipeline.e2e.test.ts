/**
 * @arcaai/room - Audio Pipeline E2E Tests
 *
 * End-to-end tests for the audio pipeline with multiple configurations.
 * Tests cover:
 * 1. No plugins - basic audio pipeline
 * 2. Auto Gain Control (AGC) feature
 * 3. Noise Suppression feature
 * 4. Echo Cancellation feature
 * 5. Voice Isolation feature (experimental)
 * 6. Voice Activity Detection (VAD) plugin integration
 * 7. Noise Filter plugin integration
 * 8. Multi-configuration with all features and plugins combined
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioTrack, type AudioTrackOptions } from '../core/AudioTrack.js';
import { ProcessorPipeline } from '../core/ProcessorPipeline.js';
import { BaseProcessor } from '../processors/BaseProcessor.js';
import { ProcessorStatus, type AudioProcessorOptions } from '../processors/types.js';
import { ProcessorEvent } from '../events/ProcessorEvents.js';
import { TrackEvent } from '../events/TrackEvents.js';
import { AudioFeature, TrackState, type AudioLevelInfo } from '../types/index.js';

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MediaStreamTrack with configurable settings.
 */
function createMockTrack(settings: Partial<MediaTrackSettings> = {}): MediaStreamTrack {
  const defaultSettings: MediaTrackSettings = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    deviceId: 'mock-device',
    groupId: 'mock-group',
    ...settings,
  };

  return {
    kind: 'audio',
    id: `mock-track-${Math.random().toString(36).substring(7)}`,
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock Audio Track',
    stop: vi.fn(),
    clone: vi.fn().mockReturnThis(),
    getSettings: vi.fn().mockReturnValue(defaultSettings),
    getConstraints: vi.fn().mockReturnValue({}),
    getCapabilities: vi.fn().mockReturnValue({
      echoCancellation: [true, false],
      noiseSuppression: [true, false],
      autoGainControl: [true, false],
    }),
    applyConstraints: vi.fn().mockImplementation(async (constraints) => {
      // Update settings based on constraints
      if (constraints.echoCancellation !== undefined) {
        defaultSettings.echoCancellation = Boolean(constraints.echoCancellation);
      }
      if (constraints.noiseSuppression !== undefined) {
        defaultSettings.noiseSuppression = Boolean(constraints.noiseSuppression);
      }
      if (constraints.autoGainControl !== undefined) {
        defaultSettings.autoGainControl = Boolean(constraints.autoGainControl);
      }
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

/**
 * Creates a mock AudioContext with all required methods.
 */
function createMockAudioContext(): AudioContext {
  const mockAnalyserNode = {
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    frequencyBinCount: 1024,
    getFloatTimeDomainData: vi.fn((array: Float32Array) => {
      // Simulate some audio data
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.random() * 0.1 - 0.05;
      }
    }),
    getByteFrequencyData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockGainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockDestinationTrack = createMockTrack();
  const mockMediaStreamDestination = {
    stream: {
      getAudioTracks: () => [mockDestinationTrack],
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockSourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
    createGain: vi.fn().mockReturnValue(mockGainNode),
    createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
    createMediaStreamDestination: vi.fn().mockReturnValue(mockMediaStreamDestination),
    createBiquadFilter: vi.fn().mockReturnValue({
      type: 'lowpass',
      frequency: { value: 350 },
      Q: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createScriptProcessor: vi.fn().mockReturnValue({
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as AudioContext;
}

/**
 * Creates a mock MediaStream.
 */
function createMockMediaStream(tracks: MediaStreamTrack[] = []): MediaStream {
  return {
    id: `mock-stream-${Math.random().toString(36).substring(7)}`,
    active: true,
    getAudioTracks: () => tracks,
    getVideoTracks: () => [],
    getTracks: () => tracks,
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onaddtrack: null,
    onremovetrack: null,
  } as unknown as MediaStream;
}

// ============================================================================
// Mock VAD Processor
// ============================================================================

/**
 * Mock VADProcessor that simulates voice activity detection.
 */
class MockVADProcessor extends BaseProcessor {
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private isSpeakingState = false;
  private speechProbability = 0;
  private options: {
    positiveSpeechThreshold: number;
    negativeSpeechThreshold: number;
    minSpeechMs: number;
    enableStats: boolean;
    statsInterval: number;
  };

  constructor(options: Partial<typeof MockVADProcessor.prototype.options> = {}) {
    super('vad-processor');
    this.options = {
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 250,
      enableStats: false,
      statsInterval: 1000,
      ...options,
    };
  }

  isSupported(): boolean {
    return true;
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // Create passthrough - VAD doesn't modify audio
    const stream = new MediaStream([track]);
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const destination = audioContext.createMediaStreamDestination();
    sourceNode.connect(destination);

    this.processedTrack = destination.stream.getAudioTracks()[0];

    // Start VAD monitoring
    this.startMonitoring();
  }

  protected async onDestroy(): Promise<void> {
    this.stopMonitoring();
  }

  protected async onEnable(): Promise<void> {
    this.startMonitoring();
  }

  protected async onDisable(): Promise<void> {
    this.stopMonitoring();
  }

  private startMonitoring(): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      // Simulate VAD processing
      this.speechProbability = Math.random();
      const wasSpeaking = this.isSpeakingState;

      if (this.speechProbability > this.options.positiveSpeechThreshold) {
        if (!this.isSpeakingState) {
          this.isSpeakingState = true;
          this.emitData('vad-speech-start', { timestamp: Date.now() });
        }
      } else if (this.speechProbability < this.options.negativeSpeechThreshold) {
        if (this.isSpeakingState) {
          this.isSpeakingState = false;
          this.emitData('vad-speech-end', {
            audio: new Float32Array(4800), // 300ms at 16kHz
            duration: 300,
            startTime: Date.now() - 300,
            endTime: Date.now(),
          });
        }
      }

      // Emit frame data
      this.emitData('vad-frame', {
        isSpeech: this.isSpeakingState,
        probability: this.speechProbability,
        notSpeechProbability: 1 - this.speechProbability,
        timestamp: Date.now(),
      });

      // Emit stats if enabled
      if (this.options.enableStats) {
        this.emitData('vad-stats', {
          isActive: true,
          isSpeaking: this.isSpeakingState,
          speechProbability: this.speechProbability,
          currentSpeechDuration: this.isSpeakingState ? 100 : 0,
          framesProcessed: 1,
          speechSegmentsDetected: 0,
          misfireCount: 0,
          averageSpeechProbability: this.speechProbability,
          timestamp: Date.now(),
        });
      }
    }, 50);
  }

  private stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  // Public API
  isSpeaking(): boolean {
    return this.isSpeakingState;
  }

  getSpeechProbability(): number {
    return this.speechProbability;
  }

  getStats() {
    return {
      isActive: this._enabled,
      isSpeaking: this.isSpeakingState,
      speechProbability: this.speechProbability,
      currentSpeechDuration: 0,
      framesProcessed: 0,
      speechSegmentsDetected: 0,
      misfireCount: 0,
      averageSpeechProbability: 0,
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// Mock Noise Filter Processor
// ============================================================================

/**
 * Mock NoiseFilterProcessor that simulates AI-powered noise cancellation.
 */
class MockNoiseFilterProcessor extends BaseProcessor {
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private stats = {
    isActive: false,
    noiseReductionDb: 0,
    vadProbability: 0,
    latencyMs: 10,
    framesProcessed: 0,
    framesDropped: 0,
    cpuLoad: 0.1,
    timestamp: Date.now(),
  };
  private options: {
    noiseCancellation: boolean;
    noiseCancellationLevel: 'low' | 'medium' | 'high';
    echoCancellation: boolean;
    autoGainControl: boolean;
    enableStats: boolean;
    statsInterval: number;
  };

  constructor(options: Partial<typeof MockNoiseFilterProcessor.prototype.options> = {}) {
    super('noise-filter-processor');
    this.options = {
      noiseCancellation: true,
      noiseCancellationLevel: 'medium',
      echoCancellation: true,
      autoGainControl: true,
      enableStats: false,
      statsInterval: 1000,
      ...options,
    };
  }

  isSupported(): boolean {
    return true;
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // Create source node from input track
    const stream = new MediaStream([track]);
    const sourceNode = audioContext.createMediaStreamSource(stream);

    // Create gain node to simulate noise filtering
    const gainNode = audioContext.createGain();
    gainNode.gain.value = this.getLevelGain();

    // Create destination
    const destination = audioContext.createMediaStreamDestination();
    sourceNode.connect(gainNode);
    gainNode.connect(destination);

    this.processedTrack = destination.stream.getAudioTracks()[0];
    this.stats.isActive = true;

    // Start stats emission
    if (this.options.enableStats) {
      this.startStatsEmission();
    }
  }

  protected async onDestroy(): Promise<void> {
    this.stopStatsEmission();
    this.stats.isActive = false;
  }

  protected async onEnable(): Promise<void> {
    this.stats.isActive = true;
  }

  protected async onDisable(): Promise<void> {
    this.stats.isActive = false;
  }

  private getLevelGain(): number {
    switch (this.options.noiseCancellationLevel) {
      case 'low':
        return 0.95;
      case 'medium':
        return 0.9;
      case 'high':
        return 0.85;
      default:
        return 0.9;
    }
  }

  private startStatsEmission(): void {
    if (this.statsInterval) return;

    this.statsInterval = setInterval(() => {
      this.stats.framesProcessed++;
      this.stats.noiseReductionDb = Math.random() * 10 + 5;
      this.stats.vadProbability = Math.random();
      this.stats.cpuLoad = Math.random() * 0.2;
      this.stats.timestamp = Date.now();

      this.emitData('noise-stats', this.stats);
    }, this.options.statsInterval);
  }

  private stopStatsEmission(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  // Public API
  async setNoiseLevel(level: 'low' | 'medium' | 'high'): Promise<void> {
    this.options.noiseCancellationLevel = level;
  }

  getNoiseLevel(): string {
    return this.options.noiseCancellationLevel;
  }

  getStats() {
    return { ...this.stats };
  }

  isUsingFallback(): boolean {
    return false;
  }

  getOptions() {
    return { ...this.options };
  }
}

// ============================================================================
// Mock getUserMedia
// ============================================================================

function setupMockGetUserMedia(track?: MediaStreamTrack): void {
  const mockTrack = track ?? createMockTrack();
  const mockStream = createMockMediaStream([mockTrack]);

  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue(mockStream),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  // Mock MediaStream constructor
  vi.stubGlobal('MediaStream', function (tracks?: MediaStreamTrack[]) {
    if (tracks && tracks.length > 0) {
      return createMockMediaStream(tracks);
    }
    return createMockMediaStream([mockTrack]);
  });
}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Audio Pipeline E2E Tests', () => {
  let audioContext: AudioContext;
  let mockTrack: MediaStreamTrack;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    audioContext = createMockAudioContext();
    mockTrack = createMockTrack();
    setupMockGetUserMedia(mockTrack);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Test 1: No Plugin - Basic Audio Pipeline
  // ==========================================================================

  describe('1. No Plugin - Basic Audio Pipeline', () => {
    it('should create a basic audio track without any plugins', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      expect(track.isActive()).toBe(true);
      expect(track.getState()).toBe(TrackState.ACTIVE);
      expect(track.mediaStreamTrack).toBeDefined();
      expect(track.hasProcessor()).toBe(false);

      await track.stop();
      expect(track.getState()).toBe(TrackState.ENDED);
    });

    it('should capture audio without any processing', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      // Verify no features are explicitly set (use device defaults)
      const settings = track.getSettings();
      expect(settings).toBeDefined();

      await track.stop();
    });

    it('should emit audio level events', async () => {
      const track = new AudioTrack({ audioContext, monitorAudioLevel: true });
      const levelHandler = vi.fn();

      await track.initialize();
      track.on(TrackEvent.AudioLevelUpdate, levelHandler);

      // Advance timers to trigger level monitoring
      await vi.advanceTimersByTimeAsync(100);

      expect(levelHandler).toHaveBeenCalled();

      const lastCall = levelHandler.mock.calls[levelHandler.mock.calls.length - 1];
      const levelInfo = lastCall[0] as AudioLevelInfo;
      expect(levelInfo).toHaveProperty('level');
      expect(levelInfo).toHaveProperty('isSpeaking');
      expect(levelInfo).toHaveProperty('peak');
      expect(levelInfo).toHaveProperty('average');

      await track.stop();
    });

    it('should support mute and unmute operations', async () => {
      const track = new AudioTrack({ audioContext });
      const muteHandler = vi.fn();
      const unmuteHandler = vi.fn();

      await track.initialize();
      track.on(TrackEvent.Muted, muteHandler);
      track.on(TrackEvent.Unmuted, unmuteHandler);

      expect(track.isMuted()).toBe(false);

      track.mute();
      expect(track.isMuted()).toBe(true);
      expect(muteHandler).toHaveBeenCalled();

      track.unmute();
      expect(track.isMuted()).toBe(false);
      expect(unmuteHandler).toHaveBeenCalled();

      await track.stop();
    });

    it('should handle track restart correctly', async () => {
      const track = new AudioTrack({ audioContext });
      const restartHandler = vi.fn();

      await track.initialize();
      track.on(TrackEvent.Restarted, restartHandler);

      await track.restart();

      expect(restartHandler).toHaveBeenCalled();
      expect(track.isActive()).toBe(true);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 2: With Auto Gain Control (AGC)
  // ==========================================================================

  describe('2. With Auto Gain Control (AGC)', () => {
    it('should initialize with AGC enabled', async () => {
      const agcTrack = createMockTrack({ autoGainControl: true });
      setupMockGetUserMedia(agcTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ autoGainControl: true });

      expect(track.isActive()).toBe(true);
      expect(track.isFeatureEnabled(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);

      await track.stop();
    });

    it('should toggle AGC dynamically', async () => {
      const agcTrack = createMockTrack({ autoGainControl: true });
      setupMockGetUserMedia(agcTrack);

      const track = new AudioTrack({ audioContext });
      const featureHandler = vi.fn();

      await track.initialize({ autoGainControl: true });
      track.on(TrackEvent.FeatureUpdate, featureHandler);

      // Disable AGC
      await track.setFeature(AudioFeature.AUTO_GAIN_CONTROL, false);

      expect(featureHandler).toHaveBeenCalledWith({
        feature: AudioFeature.AUTO_GAIN_CONTROL,
        enabled: false,
      });

      // Enable AGC
      await track.setFeature(AudioFeature.AUTO_GAIN_CONTROL, true);

      expect(featureHandler).toHaveBeenCalledWith({
        feature: AudioFeature.AUTO_GAIN_CONTROL,
        enabled: true,
      });

      await track.stop();
    });

    it('should work with AGC and audio level monitoring', async () => {
      const agcTrack = createMockTrack({ autoGainControl: true });
      setupMockGetUserMedia(agcTrack);

      const track = new AudioTrack({ audioContext, monitorAudioLevel: true });
      const levelHandler = vi.fn();

      await track.initialize({ autoGainControl: true });
      track.on(TrackEvent.AudioLevelUpdate, levelHandler);

      await vi.advanceTimersByTimeAsync(100);

      expect(levelHandler).toHaveBeenCalled();

      await track.stop();
    });

    it('should persist AGC setting after restart', async () => {
      const agcTrack = createMockTrack({ autoGainControl: true });
      setupMockGetUserMedia(agcTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ autoGainControl: true });

      await track.restart({ autoGainControl: true });

      expect(track.isActive()).toBe(true);
      expect(track.isFeatureEnabled(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 3: With Noise Suppression
  // ==========================================================================

  describe('3. With Noise Suppression', () => {
    it('should initialize with noise suppression enabled', async () => {
      const nsTrack = createMockTrack({ noiseSuppression: true });
      setupMockGetUserMedia(nsTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ noiseSuppression: true });

      expect(track.isActive()).toBe(true);
      expect(track.isFeatureEnabled(AudioFeature.NOISE_SUPPRESSION)).toBe(true);

      await track.stop();
    });

    it('should toggle noise suppression dynamically', async () => {
      const nsTrack = createMockTrack({ noiseSuppression: true });
      setupMockGetUserMedia(nsTrack);

      const track = new AudioTrack({ audioContext });
      const featureHandler = vi.fn();

      await track.initialize({ noiseSuppression: true });
      track.on(TrackEvent.FeatureUpdate, featureHandler);

      await track.setFeature(AudioFeature.NOISE_SUPPRESSION, false);

      expect(featureHandler).toHaveBeenCalledWith({
        feature: AudioFeature.NOISE_SUPPRESSION,
        enabled: false,
      });

      await track.stop();
    });

    it('should combine noise suppression with AGC', async () => {
      const combinedTrack = createMockTrack({
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(combinedTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({
        noiseSuppression: true,
        autoGainControl: true,
      });

      const features = track.getFeatures();
      expect(features.get(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
      expect(features.get(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 4: With Echo Cancellation
  // ==========================================================================

  describe('4. With Echo Cancellation', () => {
    it('should initialize with echo cancellation enabled', async () => {
      const ecTrack = createMockTrack({ echoCancellation: true });
      setupMockGetUserMedia(ecTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ echoCancellation: true });

      expect(track.isActive()).toBe(true);
      expect(track.isFeatureEnabled(AudioFeature.ECHO_CANCELLATION)).toBe(true);

      await track.stop();
    });

    it('should toggle echo cancellation dynamically', async () => {
      const ecTrack = createMockTrack({ echoCancellation: true });
      setupMockGetUserMedia(ecTrack);

      const track = new AudioTrack({ audioContext });
      const featureHandler = vi.fn();

      await track.initialize({ echoCancellation: true });
      track.on(TrackEvent.FeatureUpdate, featureHandler);

      await track.setFeature(AudioFeature.ECHO_CANCELLATION, false);

      expect(featureHandler).toHaveBeenCalledWith({
        feature: AudioFeature.ECHO_CANCELLATION,
        enabled: false,
      });

      await track.stop();
    });

    it('should work with echo cancellation and mute/unmute', async () => {
      const ecTrack = createMockTrack({ echoCancellation: true });
      setupMockGetUserMedia(ecTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ echoCancellation: true });

      track.mute();
      expect(track.isMuted()).toBe(true);
      expect(track.isFeatureEnabled(AudioFeature.ECHO_CANCELLATION)).toBe(true);

      track.unmute();
      expect(track.isMuted()).toBe(false);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 5: With Voice Isolation (Experimental)
  // ==========================================================================

  describe('5. With Voice Isolation (Experimental)', () => {
    it('should initialize with voice isolation enabled', async () => {
      // Voice isolation is experimental and may not be supported in all browsers
      // Mock track with voice isolation capability
      const viTrack = createMockTrack();
      (viTrack.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
        voiceIsolation: true,
      });
      (viTrack.getCapabilities as ReturnType<typeof vi.fn>).mockReturnValue({
        voiceIsolation: [true, false],
      });
      setupMockGetUserMedia(viTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({ voiceIsolation: true });

      expect(track.isActive()).toBe(true);

      await track.stop();
    });

    it('should toggle voice isolation dynamically', async () => {
      const viTrack = createMockTrack();
      (viTrack.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
        voiceIsolation: true,
      });
      setupMockGetUserMedia(viTrack);

      const track = new AudioTrack({ audioContext });
      const featureHandler = vi.fn();

      await track.initialize({ voiceIsolation: true });
      track.on(TrackEvent.FeatureUpdate, featureHandler);

      await track.setFeature(AudioFeature.VOICE_ISOLATION, false);

      expect(featureHandler).toHaveBeenCalledWith({
        feature: AudioFeature.VOICE_ISOLATION,
        enabled: false,
      });

      await track.stop();
    });

    it('should combine voice isolation with other features', async () => {
      const combinedTrack = createMockTrack();
      (combinedTrack.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
        voiceIsolation: true,
        noiseSuppression: true,
        echoCancellation: true,
      });
      setupMockGetUserMedia(combinedTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({
        voiceIsolation: true,
        noiseSuppression: true,
        echoCancellation: true,
      });

      expect(track.isActive()).toBe(true);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 6: With Voice Activity Detection (VAD) Plugin
  // ==========================================================================

  describe('6. With Voice Activity Detection (VAD) Plugin Integration', () => {
    it('should attach VAD processor to audio track', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor({
        positiveSpeechThreshold: 0.5,
        enableStats: true,
      });

      await track.setProcessor(vadProcessor);

      expect(track.hasProcessor()).toBe(true);
      expect(track.getProcessor()).toBe(vadProcessor);
      expect(vadProcessor.getStatus()).toBe(ProcessorStatus.ENABLED);

      await track.stop();
    });

    it('should receive VAD events (speech start/end)', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor();
      const dataHandler = vi.fn();

      vadProcessor.on(ProcessorEvent.Data, dataHandler);
      await track.setProcessor(vadProcessor);

      // Wait for VAD processing
      await vi.advanceTimersByTimeAsync(200);

      expect(dataHandler).toHaveBeenCalled();

      // Check that VAD frame events are emitted
      const frameCalls = dataHandler.mock.calls.filter((call) => call[0].type === 'vad-frame');
      expect(frameCalls.length).toBeGreaterThan(0);

      await track.stop();
    });

    it('should emit VAD statistics', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor({
        enableStats: true,
        statsInterval: 50,
      });
      const dataHandler = vi.fn();

      vadProcessor.on(ProcessorEvent.Data, dataHandler);
      await track.setProcessor(vadProcessor);

      // Wait for stats emission
      await vi.advanceTimersByTimeAsync(100);

      const statsCalls = dataHandler.mock.calls.filter((call) => call[0].type === 'vad-stats');
      expect(statsCalls.length).toBeGreaterThan(0);

      await track.stop();
    });

    it('should provide VAD public API methods', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor();
      await track.setProcessor(vadProcessor);

      // Test public API
      expect(typeof vadProcessor.isSpeaking()).toBe('boolean');
      expect(typeof vadProcessor.getSpeechProbability()).toBe('number');
      expect(vadProcessor.getStats()).toBeDefined();

      await track.stop();
    });

    it('should handle VAD processor enable/disable', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor();
      await track.setProcessor(vadProcessor);

      expect(vadProcessor.isEnabled()).toBe(true);

      await vadProcessor.disable();
      expect(vadProcessor.isEnabled()).toBe(false);
      expect(vadProcessor.getStatus()).toBe(ProcessorStatus.DISABLED);

      await vadProcessor.enable();
      expect(vadProcessor.isEnabled()).toBe(true);
      expect(vadProcessor.getStatus()).toBe(ProcessorStatus.ENABLED);

      await track.stop();
    });

    it('should remove VAD processor cleanly', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor = new MockVADProcessor();
      const destroyedHandler = vi.fn();

      vadProcessor.on(ProcessorEvent.Destroyed, destroyedHandler);
      await track.setProcessor(vadProcessor);

      await track.stopProcessor();

      expect(destroyedHandler).toHaveBeenCalled();
      expect(track.hasProcessor()).toBe(false);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 7: With Noise Filter Plugin
  // ==========================================================================

  describe('7. With Noise Filter Plugin Integration', () => {
    it('should attach noise filter processor to audio track', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor({
        noiseCancellation: true,
        noiseCancellationLevel: 'medium',
      });

      await track.setProcessor(noiseFilter);

      expect(track.hasProcessor()).toBe(true);
      expect(track.getProcessor()).toBe(noiseFilter);
      expect(noiseFilter.getStatus()).toBe(ProcessorStatus.ENABLED);

      await track.stop();
    });

    it('should filter noise from audio signal', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor();
      await track.setProcessor(noiseFilter);

      // Verify processor is processing
      expect(noiseFilter.isEnabled()).toBe(true);
      expect(noiseFilter.processedTrack).toBeDefined();

      await track.stop();
    });

    it('should support different noise cancellation levels', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor({
        noiseCancellationLevel: 'low',
      });
      await track.setProcessor(noiseFilter);

      expect(noiseFilter.getNoiseLevel()).toBe('low');

      await noiseFilter.setNoiseLevel('high');
      expect(noiseFilter.getNoiseLevel()).toBe('high');

      await track.stop();
    });

    it('should emit noise filter statistics', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor({
        enableStats: true,
        statsInterval: 50,
      });
      const dataHandler = vi.fn();

      noiseFilter.on(ProcessorEvent.Data, dataHandler);
      await track.setProcessor(noiseFilter);

      await vi.advanceTimersByTimeAsync(100);

      const statsCalls = dataHandler.mock.calls.filter((call) => call[0].type === 'noise-stats');
      expect(statsCalls.length).toBeGreaterThan(0);

      await track.stop();
    });

    it('should provide noise filter public API methods', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor();
      await track.setProcessor(noiseFilter);

      expect(noiseFilter.getNoiseLevel()).toBe('medium');
      expect(noiseFilter.getStats()).toBeDefined();
      expect(noiseFilter.isUsingFallback()).toBe(false);
      expect(noiseFilter.getOptions()).toBeDefined();

      await track.stop();
    });

    it('should handle noise filter enable/disable', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const noiseFilter = new MockNoiseFilterProcessor();
      await track.setProcessor(noiseFilter);

      await noiseFilter.disable();
      expect(noiseFilter.isEnabled()).toBe(false);

      await noiseFilter.enable();
      expect(noiseFilter.isEnabled()).toBe(true);

      await track.stop();
    });
  });

  // ==========================================================================
  // Test 8: Multi-Configuration with All Features and Plugins
  // ==========================================================================

  describe('8. Multi-Configuration with All Features and Plugins', () => {
    it('should initialize with all native features enabled', async () => {
      const fullTrack = createMockTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(fullTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        voiceIsolation: true,
      });

      expect(track.isActive()).toBe(true);

      const features = track.getFeatures();
      expect(features.get(AudioFeature.ECHO_CANCELLATION)).toBe(true);
      expect(features.get(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
      expect(features.get(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);

      await track.stop();
    });

    it('should use ProcessorPipeline with multiple processors', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      // Create pipeline with VAD and noise filter
      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor({ noiseCancellationLevel: 'high' });
      const vadProcessor = new MockVADProcessor({ positiveSpeechThreshold: 0.6 });

      // Add processors with priority (noise filter runs first, then VAD)
      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      expect(track.hasProcessor()).toBe(true);
      expect(pipeline.getProcessors()).toHaveLength(2);
      expect(pipeline.getEnabledProcessors()).toHaveLength(2);

      await track.stop();
    });

    it('should chain processors correctly in pipeline', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor();
      const vadProcessor = new MockVADProcessor();

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      // Both processors should be initialized
      expect(noiseFilter.getStatus()).toBe(ProcessorStatus.ENABLED);
      expect(vadProcessor.getStatus()).toBe(ProcessorStatus.ENABLED);

      // Pipeline should output VAD's processed track (last in chain)
      expect(pipeline.processedTrack).toBeDefined();

      await track.stop();
    });

    it('should enable/disable individual processors in pipeline', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor();
      const vadProcessor = new MockVADProcessor();

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      // Disable VAD
      await pipeline.setEnabled('vad-processor', false);
      expect(pipeline.isProcessorEnabled('vad-processor')).toBe(false);
      expect(pipeline.getEnabledProcessors()).toHaveLength(1);

      // Re-enable VAD
      await pipeline.setEnabled('vad-processor', true);
      expect(pipeline.isProcessorEnabled('vad-processor')).toBe(true);
      expect(pipeline.getEnabledProcessors()).toHaveLength(2);

      await track.stop();
    });

    it('should receive events from all processors in pipeline', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor({ enableStats: true, statsInterval: 50 });
      const vadProcessor = new MockVADProcessor({ enableStats: true, statsInterval: 50 });

      const noiseDataHandler = vi.fn();
      const vadDataHandler = vi.fn();

      noiseFilter.on(ProcessorEvent.Data, noiseDataHandler);
      vadProcessor.on(ProcessorEvent.Data, vadDataHandler);

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      await vi.advanceTimersByTimeAsync(200);

      // Both processors should have emitted data
      expect(noiseDataHandler).toHaveBeenCalled();
      expect(vadDataHandler).toHaveBeenCalled();

      await track.stop();
    });

    it('should combine native features with plugin pipeline', async () => {
      const combinedTrack = createMockTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(combinedTrack);

      const track = new AudioTrack({ audioContext, monitorAudioLevel: true });
      await track.initialize({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      // Add processor pipeline on top of native features
      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor({ noiseCancellationLevel: 'high' });
      const vadProcessor = new MockVADProcessor();

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      // Native features should still be active
      const features = track.getFeatures();
      expect(features.get(AudioFeature.ECHO_CANCELLATION)).toBe(true);
      expect(features.get(AudioFeature.NOISE_SUPPRESSION)).toBe(true);
      expect(features.get(AudioFeature.AUTO_GAIN_CONTROL)).toBe(true);

      // Pipeline should be active
      expect(track.hasProcessor()).toBe(true);
      expect(pipeline.getEnabledProcessors()).toHaveLength(2);

      await track.stop();
    });

    it('should handle dynamic feature toggling with active pipeline', async () => {
      const combinedTrack = createMockTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(combinedTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      const pipeline = new ProcessorPipeline();
      const vadProcessor = new MockVADProcessor();
      pipeline.add(vadProcessor);

      await track.setProcessor(pipeline);

      // Toggle features while pipeline is active
      await track.setFeature(AudioFeature.NOISE_SUPPRESSION, false);
      expect(track.hasProcessor()).toBe(true);

      await track.setFeature(AudioFeature.ECHO_CANCELLATION, false);
      expect(track.hasProcessor()).toBe(true);

      await track.stop();
    });

    it('should remove processors from pipeline dynamically', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor();
      const vadProcessor = new MockVADProcessor();

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);
      expect(pipeline.getProcessors()).toHaveLength(2);

      // Remove noise filter
      await pipeline.remove('noise-filter-processor');
      expect(pipeline.getProcessors()).toHaveLength(1);
      expect(pipeline.getEnabledProcessors()).toHaveLength(1);

      await track.stop();
    });

    it('should restart track with full configuration intact', async () => {
      const combinedTrack = createMockTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(combinedTrack);

      const track = new AudioTrack({ audioContext });
      await track.initialize({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      const pipeline = new ProcessorPipeline();
      const vadProcessor = new MockVADProcessor();
      pipeline.add(vadProcessor);

      await track.setProcessor(pipeline);

      // Restart
      await track.restart({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });

      // Track should be active
      expect(track.isActive()).toBe(true);

      // Processor should be re-attached
      expect(track.hasProcessor()).toBe(true);

      await track.stop();
    });

    it('should handle complete audio pipeline lifecycle', async () => {
      const combinedTrack = createMockTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setupMockGetUserMedia(combinedTrack);

      // 1. Create track
      const track = new AudioTrack({ audioContext, monitorAudioLevel: true });
      const levelHandler = vi.fn();
      track.on(TrackEvent.AudioLevelUpdate, levelHandler);

      // 2. Initialize with all native features
      await track.initialize({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      expect(track.isActive()).toBe(true);

      // 3. Create and attach processor pipeline
      const pipeline = new ProcessorPipeline();
      const noiseFilter = new MockNoiseFilterProcessor({
        noiseCancellationLevel: 'high',
        enableStats: true,
      });
      const vadProcessor = new MockVADProcessor({
        positiveSpeechThreshold: 0.5,
        enableStats: true,
      });

      pipeline.add(noiseFilter, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);
      expect(track.hasProcessor()).toBe(true);

      // 4. Run for a bit and verify events
      await vi.advanceTimersByTimeAsync(200);
      expect(levelHandler).toHaveBeenCalled();

      // 5. Toggle some features
      await track.setFeature(AudioFeature.NOISE_SUPPRESSION, false);
      await track.setFeature(AudioFeature.NOISE_SUPPRESSION, true);

      // 6. Disable a processor
      await pipeline.setEnabled('vad-processor', false);
      expect(pipeline.getEnabledProcessors()).toHaveLength(1);

      // 7. Re-enable
      await pipeline.setEnabled('vad-processor', true);
      expect(pipeline.getEnabledProcessors()).toHaveLength(2);

      // 8. Mute/unmute
      track.mute();
      expect(track.isMuted()).toBe(true);
      track.unmute();
      expect(track.isMuted()).toBe(false);

      // 9. Restart
      await track.restart({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      expect(track.isActive()).toBe(true);

      // 10. Stop
      await track.stop();
      expect(track.getState()).toBe(TrackState.ENDED);
    });

    it('should handle errors in pipeline gracefully', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      // Create a processor that throws on destroy
      class FailingProcessor extends BaseProcessor {
        constructor() {
          super('failing-processor');
        }

        protected async onInit(opts: AudioProcessorOptions): Promise<void> {
          this.processedTrack = opts.track;
        }

        protected async onDestroy(): Promise<void> {
          throw new Error('Destroy failed');
        }
      }

      const pipeline = new ProcessorPipeline();
      const failingProcessor = new FailingProcessor();
      const vadProcessor = new MockVADProcessor();

      pipeline.add(failingProcessor, { priority: 10 });
      pipeline.add(vadProcessor, { priority: 20 });

      await track.setProcessor(pipeline);

      // Pipeline destroy should not throw despite failing processor
      await expect(pipeline.destroy()).resolves.toBeUndefined();

      await track.stop();
    });

    it('should support processor priority reordering', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const proc1 = new MockNoiseFilterProcessor();
      const proc2 = new MockVADProcessor();
      const proc3 = new MockNoiseFilterProcessor();

      // Cast to update name for testing
      Object.defineProperty(proc3, 'name', { value: 'noise-filter-processor-2' });

      // Add in non-priority order
      pipeline.add(proc2, { priority: 20 }); // VAD - middle
      pipeline.add(proc1, { priority: 10 }); // Noise - first
      pipeline.add(proc3, { priority: 30 }); // Noise 2 - last

      await track.setProcessor(pipeline);

      // Verify order
      const processors = pipeline.getProcessors();
      expect(processors[0]?.processor.name).toBe('noise-filter-processor');
      expect(processors[1]?.processor.name).toBe('vad-processor');
      expect(processors[2]?.processor.name).toBe('noise-filter-processor-2');

      await track.stop();
    });
  });

  // ==========================================================================
  // Edge Cases and Error Handling
  // ==========================================================================

  describe('Edge Cases and Error Handling', () => {
    it('should handle processor initialization failure', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      class FailingInitProcessor extends BaseProcessor {
        constructor() {
          super('failing-init-processor');
        }

        protected async onInit(): Promise<void> {
          throw new Error('Init failed');
        }

        protected async onDestroy(): Promise<void> {}
      }

      const failingProcessor = new FailingInitProcessor();

      await expect(track.setProcessor(failingProcessor)).rejects.toThrow('Init failed');

      await track.stop();
    });

    it('should handle rapid mute/unmute operations', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      // Rapid toggle
      for (let i = 0; i < 10; i++) {
        track.mute();
        track.unmute();
      }

      expect(track.isMuted()).toBe(false);
      expect(track.isActive()).toBe(true);

      await track.stop();
    });

    it('should handle processor replacement', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const vadProcessor1 = new MockVADProcessor();
      const vadProcessor2 = new MockVADProcessor();

      // Cast to update name
      Object.defineProperty(vadProcessor2, 'name', { value: 'vad-processor-2' });

      await track.setProcessor(vadProcessor1);
      expect(track.getProcessor()).toBe(vadProcessor1);

      // Replace with new processor
      await track.setProcessor(vadProcessor2);
      expect(track.getProcessor()).toBe(vadProcessor2);
      expect(vadProcessor1.getStatus()).toBe(ProcessorStatus.DESTROYED);

      await track.stop();
    });

    it('should handle empty pipeline', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      await track.setProcessor(pipeline);

      // Empty pipeline should pass through original track
      expect(pipeline.processedTrack).toBe(track.sourceMediaStreamTrack);

      await track.stop();
    });

    it('should handle all processors disabled in pipeline', async () => {
      const track = new AudioTrack({ audioContext });
      await track.initialize();

      const pipeline = new ProcessorPipeline();
      const vadProcessor = new MockVADProcessor();
      const noiseFilter = new MockNoiseFilterProcessor();

      pipeline.add(vadProcessor, { enabled: false });
      pipeline.add(noiseFilter, { enabled: false });

      await track.setProcessor(pipeline);

      expect(pipeline.getEnabledProcessors()).toHaveLength(0);
      // Should pass through original track
      expect(pipeline.processedTrack).toBe(track.sourceMediaStreamTrack);

      await track.stop();
    });
  });
});
