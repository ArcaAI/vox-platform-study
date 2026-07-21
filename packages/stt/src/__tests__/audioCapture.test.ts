/**
 * @arcaai/stt - AudioWorklet capture tests
 *
 * Verifies `createAudioCapture` prefers `AudioWorkletNode` and gracefully
 * falls back to `ScriptProcessorNode` (with a `console.warn`) when the
 * runtime does not expose `audioWorklet`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAudioCapture, isAudioWorkletUsable, __resetScriptProcessorWarning } from '../core/audioCapture.js';

interface FakeWorkletPort {
  onmessage: ((event: MessageEvent<Float32Array>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

interface FakeWorkletNode {
  port: FakeWorkletPort;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeScriptProcessor {
  bufferSize: number;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (i: number) => Float32Array } }) => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeContextOptions {
  withAudioWorklet: boolean;
}

let lastWorkletNode: FakeWorkletNode | null = null;
let lastScriptProcessor: FakeScriptProcessor | null = null;

function makeAudioContext(opts: FakeContextOptions): AudioContext {
  const destination = {} as unknown;

  const ctx = {
    destination,
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createScriptProcessor: vi.fn((bufferSize: number) => {
      const proc: FakeScriptProcessor = {
        bufferSize,
        onaudioprocess: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      lastScriptProcessor = proc;
      return proc;
    }),
    createGain: vi.fn((): FakeGain => ({
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    audioWorklet: opts.withAudioWorklet
      ? {
          addModule: vi.fn().mockResolvedValue(undefined),
        }
      : undefined,
  };

  return ctx as unknown as AudioContext;
}

let lastWorkletNodeOptions: AudioWorkletNodeOptions | undefined;

function setupAudioWorkletNodeMock(): void {
  class MockAudioWorkletNode {
    port: FakeWorkletPort;
    connect = vi.fn();
    disconnect = vi.fn();

    constructor(_ctx: AudioContext, _name: string, options?: AudioWorkletNodeOptions) {
      this.port = {
        onmessage: null,
        postMessage: vi.fn(),
      };
      lastWorkletNodeOptions = options;
      lastWorkletNode = this as unknown as FakeWorkletNode;
    }
  }

  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = MockAudioWorkletNode;
}

function removeAudioWorkletNodeGlobal(): void {
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = undefined;
}

describe('C-3: AudioWorklet capture with ScriptProcessor fallback', () => {
  let originalWorkletNode: typeof AudioWorkletNode | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalWorkletNode = (globalThis as unknown as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;
    lastWorkletNode = null;
    lastWorkletNodeOptions = undefined;
    lastScriptProcessor = null;
    __resetScriptProcessorWarning();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = originalWorkletNode;
    warnSpy.mockRestore();
  });

  describe('isAudioWorkletUsable', () => {
    it('returns true when AudioWorkletNode exists and context.audioWorklet is defined', () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      expect(isAudioWorkletUsable(ctx)).toBe(true);
    });

    it('returns false when context.audioWorklet is missing', () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: false });
      expect(isAudioWorkletUsable(ctx)).toBe(false);
    });

    it('returns false when AudioWorkletNode global is missing', () => {
      removeAudioWorkletNodeGlobal();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      expect(isAudioWorkletUsable(ctx)).toBe(false);
    });
  });

  describe('createAudioCapture - AudioWorklet path', () => {
    it('creates an AudioWorkletNode (not a ScriptProcessor) when AudioWorklet is available', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      const handle = await createAudioCapture(ctx, track, () => {});

      expect(handle.usesWorklet).toBe(true);
      expect(lastWorkletNode).not.toBeNull();
      expect(lastScriptProcessor).toBeNull();
      expect(ctx.createScriptProcessor).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      handle.destroy();
    });

    it('forwards frames from the worklet port to onFrame', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      const frames: Float32Array[] = [];
      await createAudioCapture(ctx, track, (frame) => frames.push(frame));

      const incoming = new Float32Array([0.1, -0.2, 0.3]);
      lastWorkletNode!.port.onmessage?.({ data: incoming } as MessageEvent<Float32Array>);

      expect(frames).toHaveLength(1);
      expect(frames[0]).toBe(incoming);
    });

    it('sends setEnabled message to the worklet on toggle', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      const handle = await createAudioCapture(ctx, track, () => {});
      handle.setEnabled(false);

      expect(lastWorkletNode!.port.postMessage).toHaveBeenCalledWith({ type: 'setEnabled', enabled: false });
    });

    it('disconnects worklet and source on destroy()', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      const handle = await createAudioCapture(ctx, track, () => {});
      handle.destroy();

      expect(lastWorkletNode!.disconnect).toHaveBeenCalled();
    });

    it('defaults frameMs to 80 in the worklet processorOptions (TASK-351 P0-1)', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      await createAudioCapture(ctx, track, () => {});

      expect(lastWorkletNodeOptions?.processorOptions).toMatchObject({ frameMs: 80 });
    });

    it('plumbs a custom frameMs to the worklet processorOptions (TASK-351 P0-1)', async () => {
      setupAudioWorkletNodeMock();
      const ctx = makeAudioContext({ withAudioWorklet: true });
      const track = {} as unknown as MediaStreamTrack;

      await createAudioCapture(ctx, track, () => {}, { frameMs: 40 });

      expect(lastWorkletNodeOptions?.processorOptions).toMatchObject({ frameMs: 40 });
    });
  });

  describe('createAudioCapture - ScriptProcessor fallback', () => {
    it('falls back to ScriptProcessor and logs a warning when AudioWorklet is unavailable', async () => {
      removeAudioWorkletNodeGlobal();
      const ctx = makeAudioContext({ withAudioWorklet: false });
      const track = {} as unknown as MediaStreamTrack;

      const handle = await createAudioCapture(ctx, track, () => {});

      expect(handle.usesWorklet).toBe(false);
      expect(lastWorkletNode).toBeNull();
      expect(lastScriptProcessor).not.toBeNull();
      expect(lastScriptProcessor!.bufferSize).toBe(4096);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toMatch(/AudioWorklet not available/i);

      handle.destroy();
    });

    it('forwards onaudioprocess frames to onFrame when fallback is active', async () => {
      removeAudioWorkletNodeGlobal();
      const ctx = makeAudioContext({ withAudioWorklet: false });
      const track = {} as unknown as MediaStreamTrack;

      const frames: Float32Array[] = [];
      const handle = await createAudioCapture(ctx, track, (frame) => frames.push(frame));

      const sample = new Float32Array([0.4, -0.1]);
      lastScriptProcessor!.onaudioprocess?.({
        inputBuffer: { getChannelData: () => sample },
      });

      expect(frames).toHaveLength(1);
      expect(frames[0]?.length).toBe(2);
      expect(frames[0]?.[0]).toBeCloseTo(0.4);

      handle.destroy();
    });

    it('suppresses frames after setEnabled(false) on fallback path', async () => {
      removeAudioWorkletNodeGlobal();
      const ctx = makeAudioContext({ withAudioWorklet: false });
      const track = {} as unknown as MediaStreamTrack;

      const frames: Float32Array[] = [];
      const handle = await createAudioCapture(ctx, track, (frame) => frames.push(frame));
      handle.setEnabled(false);

      lastScriptProcessor!.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(2) },
      });

      expect(frames).toHaveLength(0);
      handle.destroy();
    });
  });
});
