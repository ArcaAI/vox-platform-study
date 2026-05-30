/**
 * Global Vitest Setup
 *
 * This file is loaded before all tests run.
 * Use it for global configuration and setup.
 *
 * NOTE: Environment variables should be loaded via dotenv-cli in package.json scripts:
 *   "test:unit": "dotenv -e .env.test -- vitest run ..."
 *
 * This ensures consistent env loading and prevents the .env file from
 * overriding test configuration.
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Verify test environment is set (should be set by dotenv-cli)
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    'WARNING: NODE_ENV is not "test". Tests should be run with dotenv-cli:\n' +
    '  pnpm test:unit (which uses dotenv -e .env.test)'
  );
  process.env.NODE_ENV = 'test';
}

// Node 25+ ships a native localStorage on globalThis that has no working
// methods unless --localstorage-file is provided. When vitest uses jsdom the
// environment normally supplies a working Storage, but the native getter can
// shadow it. Patch it here so every workspace project gets a functional mock.
if (typeof globalThis.localStorage === 'undefined' ||
    typeof globalThis.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {};
  const localStorageFallback = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageFallback,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Browser audio-API mocks for jsdom-environment packages (room / stt / vad).
//
// Vitest 4 removed `vitest.workspace.ts` support, so the per-package
// `vitest.setup.ts` files (which used to register these globals) no longer
// run under the single-project root config used by `pnpm test:unit`. jsdom
// does not implement the Web Audio / MediaStream APIs, so we register the
// same mocks here, scoped to browser-like environments only (so node-env
// suites are left untouched). Defined as `configurable`/`writable` so tests
// can override and restore them (e.g. AudioContextManager save/restore specs).
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  class MockAudioContext {
    sampleRate = 48000;
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = { channelCount: 2, maxChannelCount: 2 };
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };

    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createMediaStreamDestination = vi.fn(() => ({
      stream: { getAudioTracks: vi.fn(() => [{}]) },
    }));
    createScriptProcessor = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    }));
    createAnalyser = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 2048,
      getFloatTimeDomainData: vi.fn(),
      getByteFrequencyData: vi.fn(),
    }));
    createGain = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1, setValueAtTime: vi.fn() },
    }));
    createBiquadFilter = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      type: 'lowpass',
      frequency: { value: 350, setValueAtTime: vi.fn() },
      Q: { value: 1, setValueAtTime: vi.fn() },
    }));

    close = vi.fn().mockResolvedValue(undefined);
    suspend = vi.fn().mockResolvedValue(undefined);
    resume = vi.fn().mockResolvedValue(undefined);
  }

  class MockAudioWorkletNode {
    port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
    connect = vi.fn();
    disconnect = vi.fn();
    parameters = new Map();
  }

  class MockMediaStreamTrack {
    id = 'mock-track-id';
    kind: 'audio' | 'video' = 'audio';
    enabled = true;
    muted = false;
    readyState: MediaStreamTrackState = 'live';
    label = 'Mock Audio Track';

    stop = vi.fn();
    clone = vi.fn(() => new MockMediaStreamTrack());
    getConstraints = vi.fn(() => ({}));
    getSettings = vi.fn(() => ({ sampleRate: 48000 }));
    applyConstraints = vi.fn().mockResolvedValue(undefined);
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispatchEvent = vi.fn();
  }

  class MockMediaStream {
    id = 'mock-stream-id';
    active = true;
    private tracks: MockMediaStreamTrack[];

    constructor(tracks?: MediaStreamTrack[]) {
      this.tracks = tracks
        ? (tracks as unknown as MockMediaStreamTrack[])
        : [new MockMediaStreamTrack()];
    }

    getAudioTracks = () => this.tracks;
    getVideoTracks = () => [] as MockMediaStreamTrack[];
    getTracks = () => this.tracks;
    addTrack = vi.fn();
    removeTrack = vi.fn();
    clone = vi.fn(() => new MockMediaStream());
  }

  for (const [name, value] of [
    ['AudioContext', MockAudioContext],
    ['AudioWorkletNode', MockAudioWorkletNode],
    ['MediaStreamTrack', MockMediaStreamTrack],
    ['MediaStream', MockMediaStream],
  ] as const) {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}

// Global test setup
beforeAll(async () => {
  // Any global setup needed before all tests
});

afterAll(async () => {
  // Any global cleanup needed after all tests
});

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Global test utilities
declare global {
  // Add any global test utilities here
  var testUtils: {
    sleep: (ms: number) => Promise<void>;
  };
}

globalThis.testUtils = {
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
