import { vi } from 'vitest';

// Mock @huggingface/transformers for unit tests
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: {
    allowLocalModels: true,
    useBrowserCache: true,
  },
}));

// Mock @arcaai/room BaseProcessor
vi.mock('@arcaai/room', () => ({
  BaseProcessor: class MockBaseProcessor {
    name: string;
    processedTrack?: MediaStreamTrack;
    protected status = 'idle';
    protected _enabled = true;

    constructor(name: string) {
      this.name = name;
    }

    getStatus() {
      return this.status;
    }

    isEnabled() {
      return this._enabled;
    }

    isSupported() {
      return true;
    }

    async init() {}
    async restart() {}
    async destroy() {}
    async enable() {
      this._enabled = true;
    }
    async disable() {
      this._enabled = false;
    }

    on() {}
    off() {}
    emit() {}

    protected emitData(type: string, data: unknown) {}
  },
  ProcessorEvent: {
    Ready: 'ready',
    Enabled: 'enabled',
    Disabled: 'disabled',
    Destroyed: 'destroyed',
    Error: 'error',
    Data: 'data',
  },
  ProcessorStatus: {
    IDLE: 'idle',
    INITIALIZING: 'initializing',
    READY: 'ready',
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    ERROR: 'error',
    DESTROYED: 'destroyed',
  },
}));
