# Room (`@arcaai/room`)

A React-based audio processing package with a three-layer architecture and plugin system. Provides audio capture, real-time level monitoring, device management, and a processor pipeline ready for VAD, transcription, and noise filtering plugins.

## Overview

`@arcaai/room` is the foundational audio layer for the ARCAAI SDK ecosystem. It manages the full lifecycle of browser audio — from `getUserMedia` capture through WebRTC native processing, track processor plugins, and Web Audio API analysis. All other audio plugins ([`@arcaai/vad`](../vad/README.md), `@arcaai/stt`, [`@arcaai/noise-filter`](../noise-filter/README.md)) integrate through the `TrackProcessor` interface and `ProcessorPipeline` defined here.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     @arcaai/room Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: WebRTC Native                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ MediaStream Constraints                                   │   │
│  │ echoCancellation · noiseSuppression · autoGainControl     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  Layer 2: Track Processors                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ProcessorPipeline                                         │   │
│  │ VAD · NoiseFilter · STT · Custom Processors              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  Layer 3: Web Audio API                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ AudioContext · AudioWorklet · AnalyserNode                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Layer 1** applies WebRTC-native audio processing (echo cancellation, noise suppression, auto gain control) at the MediaStream level.

**Layer 2** runs `TrackProcessor` plugins that can modify or analyze the audio stream. Multiple processors chain through `ProcessorPipeline`.

**Layer 3** uses the Web Audio API for level monitoring (`AnalyserNode`) and advanced processing (`AudioWorklet`).

## Installation

```bash
npm install @arcaai/room
```

### Peer Dependencies

| Dependency | Version |
|------------|---------|
| `react` | `^18.3.0 \|\| ^19.0.4` |

## API Reference

### Components

#### RoomProvider

React context provider for room-wide audio state management.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `options` | `{ webAudioMix?: boolean }` | `{}` | Room options |
| `autoConnect` | `boolean` | `false` | Auto-initialize AudioContext |
| `onConnect` | `() => void` | — | Called when room connects |
| `onError` | `(error: Error) => void` | — | Called on error |
| `children` | `React.ReactNode` | — | Child components |

```tsx
import { RoomProvider } from '@arcaai/room';

<RoomProvider options={{ webAudioMix: true }} autoConnect>
  {children}
</RoomProvider>
```

#### AudioTrackRenderer

Renders an `AudioTrack` to an `<audio>` element.

| Prop | Type | Description |
|------|------|-------------|
| `track` | `AudioTrack` | Track to render |
| `muted` | `boolean` | Mute output |
| `volume` | `number` | Volume 0–1 |

### Hooks

#### useRoom

Access the `Room` instance and connection state.

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `room` | `Room` | Room instance |
| `state` | `RoomState` | Connection state |
| `isConnected` | `boolean` | Whether AudioContext is active |
| `audioContext` | `AudioContext \| null` | Underlying AudioContext |
| `localTracks` | `AudioTrack[]` | Active local tracks |
| `connect()` | `() => Promise<void>` | Initialize AudioContext |
| `disconnect()` | `() => Promise<void>` | Tear down room |
| `createLocalTrack(opts)` | `(opts) => Promise<AudioTrack>` | Create a new audio track |
| `removeLocalTrack(track)` | `(AudioTrack) => void` | Remove and stop a track |
| `resumeAudio()` | `() => Promise<void>` | Resume suspended AudioContext |
| `canPlayAudio` | `boolean` | Whether audio can play |

#### useAudioTrack

Create and manage an audio track with built-in capture controls.

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `track` | `AudioTrack \| null` | The audio track |
| `isCapturing` | `boolean` | Whether capture is active |
| `state` | `TrackState` | Track state |
| `error` | `Error \| null` | Error |
| `isMuted` | `boolean` | Whether muted |
| `startCapture()` | `() => Promise<void>` | Start audio capture |
| `stopCapture()` | `() => Promise<void>` | Stop audio capture |
| `mute()` | `() => void` | Mute |
| `unmute()` | `() => void` | Unmute |
| `toggleMute()` | `() => void` | Toggle mute |
| `setFeature(feature, enabled)` | `(AudioFeature, boolean) => Promise<void>` | Toggle WebRTC feature |
| `restart()` | `() => Promise<void>` | Restart the track |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `noiseSuppression` | `boolean` | `false` | WebRTC native noise suppression |
| `echoCancellation` | `boolean` | `false` | WebRTC echo cancellation |
| `autoStart` | `boolean` | `false` | Start capture on mount |

#### useAudioLevel

Monitor audio levels in real-time from a track.

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `level` | `number` | Current level 0–1 |
| `isSpeaking` | `boolean` | Simple threshold-based speaking detection |
| `peak` | `number` | Peak level since last reset |
| `average` | `number` | Average level |
| `resetPeak()` | `() => void` | Reset peak |

```tsx
const { level, isSpeaking } = useAudioLevel(track);
```

#### useDevices

Enumerate and select audio input/output devices.

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `audioInputDevices` | `MediaDeviceInfo[]` | Available input devices |
| `audioOutputDevices` | `MediaDeviceInfo[]` | Available output devices |
| `selectedInputDevice` | `string \| null` | Selected input device ID |
| `selectedOutputDevice` | `string \| null` | Selected output device ID |
| `selectInputDevice(id)` | `(string) => void` | Select input |
| `selectOutputDevice(id)` | `(string) => void` | Select output |
| `hasPermissions` | `boolean` | Whether mic permission is granted |
| `requestPermissions()` | `() => Promise<void>` | Request mic permission |
| `refreshDevices()` | `() => Promise<void>` | Refresh device list |

#### useProcessors

Manage track processors (attach, detach, enable/disable).

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `processor` | `TrackProcessor \| null` | Current processor |
| `processors` | `TrackProcessor[]` | All attached processors |
| `hasProcessor(name)` | `(string) => boolean` | Check if processor exists |
| `addProcessor(proc)` | `(TrackProcessor) => Promise<void>` | Attach a processor |
| `removeProcessor(proc)` | `(TrackProcessor) => Promise<void>` | Detach a processor |
| `setProcessorEnabled(name, enabled)` | `(string, boolean) => Promise<void>` | Toggle processor |
| `clearProcessors()` | `() => Promise<void>` | Remove all processors |

### Core Classes

#### AudioTrack

Audio track abstraction with processor support and event emission.

| Method | Description |
|--------|-------------|
| `initialize(constraints)` | Initialize with MediaStream constraints |
| `setProcessor(processor)` | Attach a processor to the track |
| `setFeature(feature, enabled)` | Toggle a WebRTC audio feature |
| `stop()` | Stop the track and clean up |
| `on(event, handler)` | Subscribe to track events |

#### ProcessorPipeline

Chain multiple `TrackProcessor` instances into a sequential pipeline.

```typescript
import { ProcessorPipeline } from '@arcaai/room';

const pipeline = new ProcessorPipeline([
  noiseFilterProcessor,
  vadProcessor,
  sttProcessor,
]);

await audioTrack.setProcessor(pipeline);
await pipeline.setEnabled('vad-processor', false);
```

| Method | Description |
|--------|-------------|
| `constructor(processors)` | Create pipeline with ordered processors |
| `setEnabled(name, enabled)` | Enable/disable a processor by name |
| `init(opts)` | Initialize all processors |
| `destroy()` | Destroy all processors |

#### AudioFeature (enum)

| Value | Description |
|-------|-------------|
| `AUTO_GAIN_CONTROL` | WebRTC auto gain control |
| `ECHO_CANCELLATION` | WebRTC echo cancellation |
| `NOISE_SUPPRESSION` | WebRTC native noise suppression |
| `VOICE_ISOLATION` | Experimental voice isolation |

### Events

#### Track Events (`TrackEvent`)

| Event | Payload | Description |
|-------|---------|-------------|
| `Muted` | `void` | Track muted |
| `Unmuted` | `void` | Track unmuted |
| `Ended` | `void` | Track stopped |
| `Restarted` | `void` | Track restarted |
| `ProcessorUpdate` | `{ processor, previousProcessor }` | Processor changed |
| `FeatureUpdate` | `{ feature, enabled }` | Audio feature toggled |
| `AudioLevelUpdate` | `AudioLevelInfo` | Audio level changed |
| `SilenceDetected` | `void` | Silence detected |
| `Error` | `{ error, context }` | Error occurred |

#### Processor Events (`ProcessorEvent`)

| Event | Payload | Description |
|-------|---------|-------------|
| `Ready` | `void` | Processor initialized |
| `Enabled` | `void` | Processor enabled |
| `Disabled` | `void` | Processor disabled |
| `Destroyed` | `void` | Processor destroyed |
| `Error` | `{ error, recoverable }` | Error occurred |
| `Data` | `{ type, data, timestamp }` | Processor-specific data |

## Usage Examples

### Basic Audio Capture

```tsx
import { RoomProvider, useAudioTrack, useAudioLevel } from '@arcaai/room';

function App() {
  return (
    <RoomProvider>
      <AudioRecorder />
    </RoomProvider>
  );
}

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture, toggleMute, isMuted } =
    useAudioTrack({ noiseSuppression: true, echoCancellation: true });

  const { level, isSpeaking } = useAudioLevel(track);

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <button onClick={toggleMute} disabled={!isCapturing}>
        {isMuted ? 'Unmute' : 'Mute'}
      </button>
      <div>Level: {(level * 100).toFixed(0)}%</div>
      <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
    </div>
  );
}
```

### Processor Pipeline with Plugins

```typescript
import { Room } from '@arcaai/room';
import { VADProcessor } from '@arcaai/vad';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { createSTT } from '@arcaai/stt';
import { ProcessorPipeline } from '@arcaai/room';

const room = new Room({ webAudioMix: true });
await room.connect();

const track = await room.createLocalTrack({ noiseSuppression: false });

const pipeline = new ProcessorPipeline([
  new NoiseFilterProcessor({ noiseCancellation: true, noiseCancellationLevel: 'high' }),
  new VADProcessor({ model: 'v5', positiveSpeechThreshold: 0.5 }),
  createSTT({ sttSocket: 'wss://api.example.com/ws/stt', features: { provider: 'remote' } }),
]);

await track.setProcessor(pipeline);
```

## Plugin Development Guide

Create custom audio processors by implementing `TrackProcessor` or extending `BaseProcessor`.

### TrackProcessor Interface

```typescript
interface TrackProcessor {
  readonly name: string;
  processedTrack?: MediaStreamTrack;

  init(opts: AudioProcessorOptions): Promise<void>;
  restart(opts: AudioProcessorOptions): Promise<void>;
  destroy(): Promise<void>;

  onAttach?(): Promise<void>;
  onDetach?(): Promise<void>;
  enable?(): Promise<void>;
  disable?(): Promise<void>;
  isEnabled?(): boolean;
  isSupported?(): boolean;
}
```

### Extending BaseProcessor

```typescript
import { BaseProcessor, type AudioProcessorOptions } from '@arcaai/room';

class MyProcessor extends BaseProcessor {
  constructor() {
    super('my-processor');
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;
    // Set up audio processing nodes
    // Assign this.processedTrack for downstream consumers
  }

  protected async onDestroy(): Promise<void> {
    // Clean up nodes and resources
  }
}
```

Emit data to consumers via `this.emitData(type, data)`, which fires a `ProcessorEvent.Data` event.

## Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome | Full | Recommended |
| Firefox | Full | — |
| Safari 17.4+ | Full | AudioWorklet supported |
| Safari < 17.4 | Partial | No AudioWorklet |
| Edge | Full | Chromium-based |

```typescript
import { getBrowserSupport, isAdvancedAudioSupported } from '@arcaai/room';

const support = getBrowserSupport();
console.log('AudioWorklet:', support.audioWorklet);
```

### Additional Hooks

- **`useRoomSafe`** — Safe version of `useRoom` that returns `null` instead of throwing when used outside `RoomProvider`.
- **`useMediaStreamAudioLevel`** — Monitor audio levels directly from a `MediaStream` (without requiring an `AudioTrack`).
