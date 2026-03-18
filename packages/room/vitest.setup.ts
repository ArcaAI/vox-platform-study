/**
 * Vitest setup file for @arcaai/room package tests.
 *
 * Sets up mocks for browser APIs not available in jsdom.
 */

import { vi } from 'vitest';

// Mock AudioContext
class MockAudioContext {
  sampleRate = 48000;
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {
    channelCount: 2,
    maxChannelCount: 2,
  };
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };

  createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });

  createMediaStreamDestination = vi.fn().mockReturnValue({
    stream: {
      getAudioTracks: vi.fn().mockReturnValue([{}]),
    },
  });

  createScriptProcessor = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null,
  });

  createAnalyser = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    fftSize: 2048,
    getFloatTimeDomainData: vi.fn(),
    getByteFrequencyData: vi.fn(),
  });

  createGain = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1, setValueAtTime: vi.fn() },
  });

  createBiquadFilter = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    type: 'lowpass',
    frequency: { value: 350, setValueAtTime: vi.fn() },
    Q: { value: 1, setValueAtTime: vi.fn() },
  });

  close = vi.fn().mockResolvedValue(undefined);
  suspend = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockResolvedValue(undefined);
}

// Mock AudioWorkletNode
class MockAudioWorkletNode {
  port = {
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  connect = vi.fn();
  disconnect = vi.fn();
  parameters = new Map();

  constructor(
    _context: AudioContext,
    _name: string,
    _options?: AudioWorkletNodeOptions
  ) {}
}

// Mock MediaStreamTrack
class MockMediaStreamTrack {
  id = 'mock-track-id';
  kind: 'audio' | 'video' = 'audio';
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = 'live';
  label = 'Mock Audio Track';

  stop = vi.fn();
  clone = vi.fn().mockImplementation(() => new MockMediaStreamTrack());
  getConstraints = vi.fn().mockReturnValue({});
  getSettings = vi.fn().mockReturnValue({ sampleRate: 48000 });
  applyConstraints = vi.fn().mockResolvedValue(undefined);

  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  dispatchEvent = vi.fn();
}

// Mock MediaStream
class MockMediaStream {
  id = 'mock-stream-id';
  active = true;

  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks?: MediaStreamTrack[]) {
    if (tracks) {
      this.tracks = tracks as unknown as MockMediaStreamTrack[];
    } else {
      this.tracks = [new MockMediaStreamTrack()];
    }
  }

  getAudioTracks = () => this.tracks;
  getVideoTracks = () => [] as MockMediaStreamTrack[];
  getTracks = () => this.tracks;
  addTrack = vi.fn();
  removeTrack = vi.fn();
  clone = vi.fn().mockImplementation(() => new MockMediaStream());
}

// Mock URL methods
const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url');
const mockRevokeObjectURL = vi.fn();

// Setup global mocks
Object.defineProperty(globalThis, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
});

Object.defineProperty(globalThis, 'AudioWorkletNode', {
  writable: true,
  value: MockAudioWorkletNode,
});

Object.defineProperty(globalThis, 'MediaStreamTrack', {
  writable: true,
  value: MockMediaStreamTrack,
});

Object.defineProperty(globalThis, 'MediaStream', {
  writable: true,
  value: MockMediaStream,
});

// Mock URL.createObjectURL and revokeObjectURL
if (typeof URL !== 'undefined') {
  URL.createObjectURL = mockCreateObjectURL;
  URL.revokeObjectURL = mockRevokeObjectURL;
}

// Mock Blob if not available
if (typeof Blob === 'undefined') {
  (globalThis as unknown as { Blob: unknown }).Blob = class MockBlob {
    content: BlobPart[];
    options: BlobPropertyBag;

    constructor(content: BlobPart[], options: BlobPropertyBag = {}) {
      this.content = content;
      this.options = options;
    }

    text = vi.fn().mockResolvedValue('');
    arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0));
  };
}

// Mock navigator.mediaDevices
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  writable: true,
  value: {
    getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
    enumerateDevices: vi.fn().mockResolvedValue([]),
    getSupportedConstraints: vi.fn().mockReturnValue({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }),
  },
});

// Export mocks for use in tests
export {
  MockAudioContext,
  MockAudioWorkletNode,
  MockMediaStreamTrack,
  MockMediaStream,
  mockCreateObjectURL,
  mockRevokeObjectURL,
};
