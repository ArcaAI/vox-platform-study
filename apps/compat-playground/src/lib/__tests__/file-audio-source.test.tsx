import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FileAudioSourceGroup, FileAudioSourceError } from '../file-audio-source';

/**
 * `FileAudioSourceGroup` — file → virtual microphone decoding.
 *
 * happy-dom has no Web Audio implementation, so the whole AudioContext surface
 * is stubbed. What is under test is the MAPPING — how many virtual mics come
 * out, which channel each one carries, and that dispose() ends every track
 * not Web Audio itself.
 *
 * The file lives under `__tests__/*.test.tsx` because the app's vitest config
 * only collects `.tsx` suites (the root node config owns `.test.ts`).
*/

interface FakeTrack {
  kind: string;
  readyState: 'live' | 'ended';
  stop: () => void;
}

function makeDestination() {
  const track: FakeTrack = {
    kind: 'audio',
    readyState: 'live',
    stop: vi.fn(() => {
      track.readyState = 'ended';
    }),
  };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track], _track: track },
    disconnect: vi.fn(),
    _track: track,
  };
}

/** The shape `FakeAudioContext.createBufferSource()` below hands back. */
interface FakeBufferSource {
  buffer: unknown;
  loop: boolean;
  playbackRate: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const created: {
  destinations: ReturnType<typeof makeDestination>[];
  buffers: ReturnType<typeof makeBuffer>[];
  nodes: FakeBufferSource[];
} = {
  destinations: [],
  buffers: [],
  nodes: [],
};

function makeBuffer(channels: number, duration: number) {
  return {
    numberOfChannels: channels,
    length: Math.round(duration * 48000),
    sampleRate: 48000,
    duration,
    getChannelData: vi.fn((c: number) => new Float32Array([c])),
    copyToChannel: vi.fn(),
  };
}

/** Per-test decode result; default is a 2-channel, 10-second buffer. */
let decoded = makeBuffer(2, 10);

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  constructor(readonly options?: { sampleRate?: number }) {}
  decodeAudioData = vi.fn(async () => decoded);
  createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
    const buffer = makeBuffer(channels, length / sampleRate);
    created.buffers.push(buffer);
    return buffer;
  });
  createMediaStreamDestination = vi.fn(() => {
    const destination = makeDestination();
    created.destinations.push(destination);
    return destination;
  });
  createBufferSource = vi.fn(() => {
    const node = {
      buffer: null as unknown,
      loop: false,
      playbackRate: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    created.nodes.push(node);
    return node;
  });
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

function makeFile(name: string): File {
  return {
    name,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as File;
}

beforeEach(() => {
  created.destinations = [];
  created.buffers = [];
  created.nodes = [];
  decoded = makeBuffer(2, 10);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileAudioSourceGroup — decoding to virtual mics', () => {
  it('maps one file to one virtual mic with the file name as its label', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('consult.wav') }]);

    expect(group.sources).toHaveLength(1);
    expect(group.sources[0]).toMatchObject({ id: 'file-1', label: 'consult.wav', duration: 10 });
    expect(group.streams).toHaveLength(1);
  });

  it('maps N files to N virtual mics in selection order', async () => {
    const group = await FileAudioSourceGroup.create([
      { file: makeFile('doctor.wav') },
      { file: makeFile('patient.wav') },
      { file: makeFile('room.wav') },
    ]);

    expect(group.sources.map((s) => [s.id, s.label])).toEqual([
      ['file-1', 'doctor.wav'],
      ['file-2', 'patient.wav'],
      ['file-3', 'room.wav'],
    ]);
  });

  it('splits a stereo file into two virtual mics (L then R)', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('stereo.wav'), splitStereo: true }]);

    expect(group.sources.map((s) => s.label)).toEqual(['stereo.wav (L)', 'stereo.wav (R)']);
    // One mono buffer per channel, filled from channel 0 then channel 1.
    expect(created.buffers).toHaveLength(2);
    expect(decoded.getChannelData).toHaveBeenCalledWith(0);
    expect(decoded.getChannelData).toHaveBeenCalledWith(1);
  });

  it('ignores splitStereo for a mono file (one mic, not two)', async () => {
    decoded = makeBuffer(1, 4);
    const group = await FileAudioSourceGroup.create([{ file: makeFile('mono.wav'), splitStereo: true }]);

    expect(group.sources.map((s) => s.label)).toEqual(['mono.wav']);
  });

  it('reports the longest track as the group duration', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);
    expect(group.duration).toBe(10);
  });

  it('rejects an empty selection', async () => {
    await expect(FileAudioSourceGroup.create([])).rejects.toBeInstanceOf(FileAudioSourceError);
  });

  it('surfaces an undecodable file as a FileAudioSourceError naming the file', async () => {
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        override decodeAudioData = vi.fn(async () => {
          throw new Error('EncodingError');
        });
      },
    );

    await expect(FileAudioSourceGroup.create([{ file: makeFile('broken.bin') }])).rejects.toThrow(/broken\.bin/);
  });
});

describe('FileAudioSourceGroup — transport', () => {
  it('play() builds one buffer source per virtual mic and starts at the current offset', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }, { file: makeFile('b.wav') }]);

    await group.play();

    expect(created.nodes).toHaveLength(2);
    created.nodes.forEach((node) => expect(node.start).toHaveBeenCalledWith(0, 0));
    expect(group.isPlaying).toBe(true);
  });

  it('pause() stops the nodes and keeps the position', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);

    await group.play();
    group.pause();

    expect(created.nodes[0].stop).toHaveBeenCalled();
    expect(group.isPlaying).toBe(false);
  });

  it('seek() restarts playback from the new offset when it was playing', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);

    await group.play();
    group.seek(4);

    // Old node stopped, a fresh one started at the seek offset.
    expect(created.nodes).toHaveLength(2);
    expect(created.nodes[1].start).toHaveBeenCalledWith(0, 4);
    expect(group.currentTime).toBe(4);
  });

  it('seek() clamps to the track bounds', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);

    group.seek(-5);
    expect(group.currentTime).toBe(0);
    group.seek(9999);
    expect(group.currentTime).toBe(10);
  });

  it('setLoop / setPlaybackRate apply to live nodes', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);

    await group.play();
    group.setLoop(true);
    group.setPlaybackRate(2);

    expect(created.nodes[0].loop).toBe(true);
    expect(created.nodes[0].playbackRate.value).toBe(2);
  });

  it('ignores a non-positive playback rate', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);
    await group.play();
    group.setPlaybackRate(0);
    expect(created.nodes[0].playbackRate.value).toBe(1);
  });
});

describe('FileAudioSourceGroup — teardown', () => {
  it('dispose() ends every virtual-mic track and closes the context', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }, { file: makeFile('b.wav') }]);
    await group.play();

    expect(created.destinations.map((d) => d._track.readyState)).toEqual(['live', 'live']);

    group.dispose();

    expect(created.destinations.map((d) => d._track.readyState)).toEqual(['ended', 'ended']);
    expect(created.nodes[0].stop).toHaveBeenCalled();
  });

  it('play() after dispose() throws instead of resurrecting a dead graph', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);
    group.dispose();

    await expect(group.play()).rejects.toBeInstanceOf(FileAudioSourceError);
  });

  it('dispose() is idempotent', async () => {
    const group = await FileAudioSourceGroup.create([{ file: makeFile('a.wav') }]);
    group.dispose();
    expect(() => group.dispose()).not.toThrow();
  });
});
