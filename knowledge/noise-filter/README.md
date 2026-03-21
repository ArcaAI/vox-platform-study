# Noise Filter (`@arcaai/noise-filter`)

AI-powered noise cancellation plugin for [`@arcaai/room`](../room/README.md). Uses RNNoise (Mozilla's open-source deep learning noise suppression) via WebAssembly for high-quality, real-time noise cancellation in the browser.

## Overview

`@arcaai/noise-filter` replaces WebRTC's native noise suppression with RNNoise, a recurrent neural network trained on a large dataset of speech and noise. It operates as a `TrackProcessor` plugin for `@arcaai/room`, processing 480-sample frames (10 ms at 48 kHz) through an AudioWorklet for low-latency operation.

The processor modifies the audio stream — downstream processors in the [`@arcaai/room` pipeline](../room/README.md) (such as [`@arcaai/vad`](../vad/README.md) and `@arcaai/stt`) receive noise-filtered audio.

When AudioWorklet is unavailable, the processor falls back to `ScriptProcessorNode` or WebRTC native noise suppression.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 NoiseFilterProcessor                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  MediaStream ──► AudioWorklet ──► Processed Output          │
│    Source         (RNNoise)                                  │
│                      │                                       │
│                      ▼                                       │
│               RNNoise WASM                                   │
│               480-sample frames                              │
│               ~85 KB binary                                  │
│                                                              │
│  Fallback chain:                                             │
│  AudioWorklet → ScriptProcessorNode → WebRTC Native NS      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### RNNoise Technology

- **Model size**: ~85 KB WASM binary
- **Frame size**: 480 samples (10 ms at 48 kHz)
- **Latency**: ~10 ms algorithmic delay
- **CPU usage**: ~1–2% on modern CPUs

Effective at removing keyboard typing, fan/AC noise, background chatter, traffic noise, and electrical humming.

## Installation

```bash
npm install @arcaai/noise-filter
```

### Peer Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@arcaai/room` | `^0.1.0` | Audio track and processor infrastructure |

## API Reference

### NoiseFilterProcessor

Main processor class extending `BaseProcessor` from `@arcaai/room`.

| Method | Type | Description |
|--------|------|-------------|
| `setNoiseLevel(level)` | `('low' \| 'medium' \| 'high') => Promise<void>` | Set cancellation intensity |
| `getNoiseLevel()` | `() => NoiseCancellationLevel` | Get current level |
| `getStats()` | `() => NoiseFilterStats` | Processing statistics |
| `isUsingFallback()` | `() => boolean` | Whether using fallback mode |
| `updateOptions(options)` | `(Partial<NoiseFilterOptions>) => void` | Update options dynamically |
| `enable()` | `() => Promise<void>` | Enable processor |
| `disable()` | `() => Promise<void>` | Disable processor |
| `destroy()` | `() => Promise<void>` | Clean up resources |

### createNoiseFilter (Factory)

```typescript
import { createNoiseFilter } from '@arcaai/noise-filter';

const noiseFilter = createNoiseFilter({
  noiseCancellation: true,
  noiseCancellationLevel: 'high',
  autoGainControl: true,
});

await audioTrack.setProcessor(noiseFilter);
await noiseFilter.setNoiseLevel('medium');
```

### useNoiseFilter (Hook)

```typescript
import { useNoiseFilter } from '@arcaai/noise-filter';

const {
  isActive,
  isEnabled,
  noiseLevel,
  noiseReductionDb,
  vadProbability,
  isUsingFallback,
  stats,
  error,
  attach,
  detach,
  enable,
  disable,
  toggle,
  setLevel,
  updateOptions,
} = useNoiseFilter({
  track,
  noiseCancellation: true,
  noiseCancellationLevel: 'high',
  autoAttach: true,
  enableStats: true,
  onStatsUpdate: (stats) => console.log('Reduction:', stats.noiseReductionDb, 'dB'),
});
```

| Property | Type | Description |
|----------|------|-------------|
| `isActive` | `boolean` | Whether noise cancellation is active |
| `isEnabled` | `boolean` | Whether the processor is enabled |
| `noiseLevel` | `NoiseCancellationLevel` | Current level |
| `noiseReductionDb` | `number` | Estimated noise reduction in dB |
| `vadProbability` | `number` | RNNoise's internal VAD probability 0–1 |
| `isUsingFallback` | `boolean` | Whether using fallback mode |
| `stats` | `NoiseFilterStats \| null` | Processing statistics |
| `error` | `Error \| null` | Error state |

## Configuration

### NoiseFilterOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `noiseCancellation` | `boolean` | `true` | Enable AI-powered noise cancellation |
| `noiseCancellationLevel` | `'low' \| 'medium' \| 'high'` | `'medium'` | Cancellation intensity |
| `echoCancellation` | `boolean` | `true` | Enable WebRTC echo cancellation |
| `autoGainControl` | `boolean` | `true` | Enable WebRTC auto gain control |
| `wasmPath` | `string?` | — | Custom path to RNNoise WASM files |
| `processingMode` | `'quality' \| 'performance'` | `'quality'` | Trade-off between quality and CPU |
| `sampleRate` | `number` | `48000` | Processing sample rate |
| `enableStats` | `boolean` | `false` | Emit statistics events |
| `statsInterval` | `number` | `1000` | Stats emission interval (ms) |

### NoiseFilterStats

| Property | Type | Description |
|----------|------|-------------|
| `isActive` | `boolean` | Whether noise cancellation is active |
| `noiseReductionDb` | `number` | Estimated noise reduction in dB |
| `vadProbability` | `number` | Voice activity probability 0–1 |
| `latencyMs` | `number` | Processing latency |
| `framesProcessed` | `number` | Total frames processed |
| `framesDropped` | `number` | Frames dropped due to lag |
| `cpuLoad` | `number` | CPU load estimate 0–1 |
| `timestamp` | `number` | Collection timestamp |

### Events

```typescript
noiseFilter.on('data', (payload) => {
  if (payload.type === 'noise-stats') {
    const stats: NoiseFilterStats = payload.data;
    console.log('Noise reduction:', stats.noiseReductionDb, 'dB');
    console.log('VAD probability:', stats.vadProbability);
    console.log('CPU load:', stats.cpuLoad);
  }
});

noiseFilter.on('ready', () => console.log('Processor ready'));
noiseFilter.on('enabled', () => console.log('Enabled'));
noiseFilter.on('disabled', () => console.log('Disabled'));
noiseFilter.on('error', (payload) => console.error(payload.error));
```

## Browser Support

| Browser | RNNoise | AudioWorklet | Fallback |
|---------|---------|--------------|----------|
| Chrome 66+ | Full | Yes | ScriptProcessor → Native NS |
| Firefox 76+ | Full | Yes | ScriptProcessor → Native NS |
| Safari 17.4+ | Full | Yes | ScriptProcessor → Native NS |
| Safari < 17.4 | Partial | No | ScriptProcessor → Native NS |
| Edge 79+ | Full | Yes | ScriptProcessor → Native NS |

```typescript
import { isRNNoiseSupported, getNoiseFilterBrowserSupport } from '@arcaai/noise-filter';

if (isRNNoiseSupported()) {
  console.log('Full RNNoise support');
}

const support = getNoiseFilterBrowserSupport();
console.log('WebAssembly:', support.webAssembly);
console.log('AudioWorklet:', support.audioWorklet);
console.log('RNNoise:', support.rnnoiseSupported);
console.log('Native fallback:', support.nativeFallbackAvailable);
```

## Usage Example

```tsx
import { RoomProvider, useAudioTrack } from '@arcaai/room';
import { useNoiseFilter } from '@arcaai/noise-filter';

function App() {
  return (
    <RoomProvider>
      <AudioRecorder />
    </RoomProvider>
  );
}

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: false,
    echoCancellation: true,
  });

  const { isEnabled, noiseReductionDb, toggle, setLevel } = useNoiseFilter({
    track,
    noiseCancellation: true,
    noiseCancellationLevel: 'high',
    autoAttach: true,
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <p>Noise Filter: {isEnabled ? 'ON' : 'OFF'}</p>
      <p>Reduction: {noiseReductionDb.toFixed(1)} dB</p>
      <button onClick={() => toggle()}>Toggle</button>
      <select onChange={(e) => setLevel(e.target.value as 'low' | 'medium' | 'high')}>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
  );
}
```

When using with other plugins, disable WebRTC native noise suppression (`noiseSuppression: false`) to avoid double processing. Place the noise filter first in the [`ProcessorPipeline`](../room/README.md) so downstream processors ([`@arcaai/vad`](../vad/README.md), `@arcaai/stt`) receive clean audio.
