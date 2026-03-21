# @arcaai/room

A React-based audio processing package with configurable features and plugin architecture. Provides best-practice audio capture and processing pipeline ready for VAD, transcription, and speaker recognition plugins.

## Features

- **Three-Layer Audio Processing**: WebRTC native, Track Processors, and Web Audio API
- **Configurable Features**: Toggle echo cancellation, noise suppression, AGC on/off
- **Plugin Architecture**: Ready for VAD, transcription, speaker recognition plugins
- **React Hooks**: Easy-to-use hooks for audio capture and processing
- **TypeScript First**: Full type safety with TypeScript
- **Browser Compatibility**: Handles iOS Safari suspended state and AudioWorklet support

## Installation

```bash
pnpm add @arcaai/room
# or
npm install @arcaai/room
# or
yarn add @arcaai/room
```

## Quick Start

### Basic Usage with RoomProvider

```tsx
import {
  RoomProvider,
  useAudioTrack,
  useAudioLevel,
  AudioFeature,
} from '@arcaai/room';

function App() {
  return (
    <RoomProvider>
      <AudioRecorder />
    </RoomProvider>
  );
}

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture, toggleMute, isMuted } =
    useAudioTrack({
      noiseSuppression: true,
      echoCancellation: true,
    });

  const { level, isSpeaking } = useAudioLevel(track);

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <button onClick={toggleMute} disabled={!isCapturing}>
        {isMuted ? 'Unmute' : 'Mute'}
      </button>
      <div>Audio Level: {(level * 100).toFixed(0)}%</div>
      <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
    </div>
  );
}
```

### Using Room Directly

```typescript
import { Room, AudioFeature } from '@arcaai/room';

const room = new Room({ webAudioMix: true });

// Connect (initializes AudioContext)
await room.connect();

// Create local audio track
const track = await room.createLocalTrack({
  noiseSuppression: true,
  echoCancellation: true,
});

// Toggle features
await track.setFeature(AudioFeature.NOISE_SUPPRESSION, false);

// Listen for events
track.on('audioLevelUpdate', (info) => {
  console.log('Level:', info.level, 'Speaking:', info.isSpeaking);
});

// Cleanup
await room.disconnect();
```

## API Reference

### Components

#### RoomProvider

React context provider for room-wide audio state management.

```tsx
<RoomProvider
  options={{ webAudioMix: true }}
  autoConnect={true}
  onConnect={() => console.log('Connected')}
  onError={(error) => console.error(error)}
>
  {children}
</RoomProvider>
```

#### AudioTrackRenderer

Renders an AudioTrack to an audio element.

```tsx
<AudioTrackRenderer track={track} muted={true} volume={0} />
```

### Hooks

#### useRoom

Access room context from within a RoomProvider.

```typescript
const {
  room,
  state,
  isConnected,
  audioContext,
  localTracks,
  connect,
  disconnect,
  createLocalTrack,
  removeLocalTrack,
  resumeAudio,
  canPlayAudio,
} = useRoom();
```

#### useAudioTrack

Create and manage audio tracks.

```typescript
const {
  track,
  isCapturing,
  state,
  error,
  isMuted,
  startCapture,
  stopCapture,
  mute,
  unmute,
  toggleMute,
  setFeature,
  restart,
} = useAudioTrack({
  noiseSuppression: true,
  echoCancellation: true,
  autoStart: false,
});
```

#### useAudioLevel

Monitor audio levels in real-time.

```typescript
const { level, isSpeaking, peak, average, resetPeak } = useAudioLevel(track);
```

#### useDevices

Enumerate and select audio devices.

```typescript
const {
  audioInputDevices,
  audioOutputDevices,
  selectedInputDevice,
  selectedOutputDevice,
  selectInputDevice,
  selectOutputDevice,
  hasPermissions,
  requestPermissions,
  refreshDevices,
} = useDevices();
```

#### useProcessors

Manage track processors.

```typescript
const {
  processor,
  processors,
  hasProcessor,
  addProcessor,
  removeProcessor,
  setProcessorEnabled,
  clearProcessors,
} = useProcessors({ track, usePipeline: true });
```

### Core Classes

#### AudioTrack

Audio track abstraction with processor support.

```typescript
const track = new AudioTrack({ audioContext });
await track.initialize({ noiseSuppression: true });

// Attach processor
await track.setProcessor(myProcessor);

// Toggle features
await track.setFeature(AudioFeature.ECHO_CANCELLATION, true);

// Listen to events
track.on(TrackEvent.AudioLevelUpdate, (info) => {
  console.log(info.level);
});

// Cleanup
await track.stop();
```

#### ProcessorPipeline

Chain multiple processors together.

```typescript
const pipeline = new ProcessorPipeline([
  vadProcessor,
  noiseFilterProcessor,
  transcriptionProcessor,
]);

await audioTrack.setProcessor(pipeline);

// Enable/disable individual processors
await pipeline.setEnabled('vad-processor', false);
```

### Audio Features

Toggle WebRTC native audio processing features:

```typescript
enum AudioFeature {
  AUTO_GAIN_CONTROL = 'autoGainControl',
  ECHO_CANCELLATION = 'echoCancellation',
  NOISE_SUPPRESSION = 'noiseSuppression',
  VOICE_ISOLATION = 'voiceIsolation', // Experimental
}
```

## Plugin Development Guide

Create custom audio processors by implementing the `TrackProcessor` interface or extending `BaseProcessor`.

### TrackProcessor Interface

```typescript
interface TrackProcessor {
  readonly name: string;
  processedTrack?: MediaStreamTrack;

  init(opts: AudioProcessorOptions): Promise<void>;
  restart(opts: AudioProcessorOptions): Promise<void>;
  destroy(): Promise<void>;

  // Optional
  onAttach?(): Promise<void>;
  onDetach?(): Promise<void>;
  enable?(): Promise<void>;
  disable?(): Promise<void>;
  isEnabled?(): boolean;
  isSupported?(): boolean;
}
```

### Debug Mode Support

All processors extending `BaseProcessor` inherit a `protected debugMode: boolean` field. Pass `debugMode` to the constructor to enable debug logging:

```typescript
class MyProcessor extends BaseProcessor {
  constructor(debugMode?: boolean) {
    super('my-processor', debugMode);
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    if (this.debugMode) {
      debugLogConfig('MyProcessor', { /* config */ });
    }
  }
}
```

The package also exports shared debug logging utilities:

| Export | Description |
|--------|-------------|
| `debugLog(component, message, data?)` | General debug log with `[ARCAAI:DEBUG]` prefix |
| `debugLogConfig(component, config)` | Log configuration as formatted JSON |
| `debugLogTranscript(component, transcript)` | Log transcript with precise numeric formatting |
| `DebugTranscriptEntry` | TypeScript interface for transcript entries |
| `DebugTranscriptWord` | TypeScript interface for word-level entries |

### Example: Custom VAD Processor

```typescript
import { BaseProcessor, type AudioProcessorOptions } from '@arcaai/room';

class VADProcessor extends BaseProcessor {
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private threshold = 0.01, debugMode?: boolean) {
    super('vad-processor', debugMode);
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // Create analyser
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    // Create source from input track
    const stream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);

    // Pass through audio (VAD doesn't modify audio)
    const destination = audioContext.createMediaStreamDestination();
    this.sourceNode.connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];

    // Start VAD monitoring
    this.startMonitoring();
  }

  protected async onDestroy(): Promise<void> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    this.sourceNode?.disconnect();
    this.analyser = null;
    this.sourceNode = null;
  }

  private startMonitoring(): void {
    const dataArray = new Float32Array(this.analyser!.fftSize);

    this.monitorInterval = setInterval(() => {
      this.analyser!.getFloatTimeDomainData(dataArray);

      // Calculate RMS level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]! * dataArray[i]!;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const isSpeaking = rms > this.threshold;

      // Emit VAD data
      this.emitData('vad', {
        isSpeaking,
        confidence: Math.min(1, rms / this.threshold),
      });
    }, 50);
  }
}

// Usage
const vadProcessor = new VADProcessor(0.01);
await audioTrack.setProcessor(vadProcessor);

vadProcessor.on('data', (payload) => {
  if (payload.type === 'vad') {
    console.log('Speaking:', payload.data.isSpeaking);
  }
});
```

### Future Plugin Packages

The architecture supports these future plugin packages:

- `@arcaai/vad` - Voice Activity Detection
- `@arcaai/transcription` - Speech-to-text
- `@arcaai/speaker-recognition` - Speaker identification

## Browser Support


| Browser       | Support | Notes                |
| ------------- | ------- | -------------------- |
| Chrome        | Full    | Recommended          |
| Firefox       | Full    | -                    |
| Safari 17.4+  | Full    | AudioWorklet support |
| Safari < 17.4 | Partial | No AudioWorklet      |
| Edge          | Full    | Chromium-based       |


Check browser support programmatically:

```typescript
import { getBrowserSupport, isAdvancedAudioSupported } from '@arcaai/room';

const support = getBrowserSupport();
console.log('Fully supported:', support.isFullySupported);
console.log('AudioWorklet:', support.audioWorklet);

if (!isAdvancedAudioSupported()) {
  console.warn('Some features may not work in this browser');
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     @arcaai/room Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: WebRTC Native                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ MediaStream Constraints                                   │   │
│  │ - echoCancellation, noiseSuppression, autoGainControl    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  Layer 2: Track Processors                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ProcessorPipeline                                         │   │
│  │ - VAD, Transcription, Speaker Recognition (plugins)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  Layer 3: Web Audio API                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ AudioContext                                              │   │
│  │ - AudioWorklet for advanced processing                   │   │
│  │ - AnalyserNode for audio level monitoring                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Events

### Track Events

```typescript
track.on(TrackEvent.Muted, () => {});
track.on(TrackEvent.Unmuted, () => {});
track.on(TrackEvent.Ended, () => {});
track.on(TrackEvent.ProcessorUpdate, (payload) => {});
track.on(TrackEvent.FeatureUpdate, (payload) => {});
track.on(TrackEvent.AudioLevelUpdate, (info) => {});
track.on(TrackEvent.Error, (payload) => {});
```

### Processor Events

```typescript
processor.on(ProcessorEvent.Ready, () => {});
processor.on(ProcessorEvent.Enabled, () => {});
processor.on(ProcessorEvent.Disabled, () => {});
processor.on(ProcessorEvent.Destroyed, () => {});
processor.on(ProcessorEvent.Error, (payload) => {});
processor.on(ProcessorEvent.Data, (payload) => {});
```

## License

MIT