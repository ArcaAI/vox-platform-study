# @arcaai/noise-filter

AI-powered noise cancellation plugin for `@arcaai/room`. Uses RNNoise (Mozilla's open-source deep learning noise suppression) via WebAssembly for high-quality, real-time noise cancellation in the browser.

## Features

- **AI-Powered Noise Cancellation**: Uses RNNoise deep learning model for superior noise reduction
- **Real-Time Processing**: AudioWorklet-based processing for low-latency operation
- **Configurable Levels**: Adjustable noise cancellation intensity (low, medium, high)
- **Fallback Support**: Graceful degradation to WebRTC native NS when needed
- **Statistics Monitoring**: Real-time stats including VAD probability and CPU load
- **Full TypeScript Support**: Comprehensive type definitions

## Installation

```bash
pnpm add @arcaai/noise-filter
# or
npm install @arcaai/noise-filter
# or
yarn add @arcaai/noise-filter
```

## Requirements

- `@arcaai/room` ^0.1.0 (peer dependency)
- Browser with WebAssembly and AudioWorklet support

## Quick Start

### Using the useNoiseFilter Hook (Recommended)

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useNoiseFilter } from '@arcaai/noise-filter';

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: false, // Disable native NS, we use RNNoise
    echoCancellation: true,
  });

  const {
    isActive,
    isEnabled,
    noiseLevel,
    noiseReductionDb,
    vadProbability,
    stats,
    toggle,
    setLevel,
    error,
  } = useNoiseFilter({
    track,
    noiseCancellation: true,
    noiseCancellationLevel: 'high',
    autoAttach: true,
    enableStats: true,
    onStatsUpdate: (stats) => {
      console.log('Noise reduction:', stats.noiseReductionDb, 'dB');
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start Recording'}
      </button>
      <div>Noise Filter: {isEnabled ? 'ON' : 'OFF'}</div>
      <div>Level: {noiseLevel}</div>
      <div>Noise Reduction: {noiseReductionDb.toFixed(1)} dB</div>
      <button onClick={() => toggle()}>Toggle Filter</button>
      <select
        value={noiseLevel}
        onChange={(e) => setLevel(e.target.value as 'low' | 'medium' | 'high')}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      {error && <div className="error">{error.message}</div>}
    </div>
  );
}
```

The `useNoiseFilter` hook provides:
- **State management**: `isActive`, `isEnabled`, `noiseLevel`, `isUsingFallback`
- **Metrics**: `noiseReductionDb`, `vadProbability`, `stats`
- **Methods**: `attach`, `detach`, `enable`, `disable`, `toggle`, `setLevel`, `updateOptions`
- **Error handling**: `error` state with automatic error propagation

### With useProcessors (Manual Approach)

```tsx
import { useAudioTrack, useProcessors } from '@arcaai/room';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { useEffect } from 'react';

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    // Disable native noise suppression since we use RNNoise
    noiseSuppression: false,
    echoCancellation: true,
  });

  const { addProcessor, removeProcessor } = useProcessors({ track });

  useEffect(() => {
    if (track) {
      const noiseFilter = new NoiseFilterProcessor({
        noiseCancellation: true,
        noiseCancellationLevel: 'high',
        enableStats: true,
      });

      // Listen for stats
      noiseFilter.on('data', (payload) => {
        if (payload.type === 'noise-stats') {
          console.log('Noise reduction:', payload.data.noiseReductionDb, 'dB');
          console.log('VAD probability:', payload.data.vadProbability);
        }
      });

      addProcessor(noiseFilter);

      return () => {
        removeProcessor(noiseFilter);
      };
    }
  }, [track, addProcessor, removeProcessor]);

  return (
    <button onClick={isCapturing ? stopCapture : startCapture}>
      {isCapturing ? 'Stop' : 'Start Recording'}
    </button>
  );
}
```

### With AudioTrack Directly

```typescript
import { AudioTrack, AudioContextManager } from '@arcaai/room';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';

async function setupAudioWithNoiseFilter() {
  // Get AudioContext
  const audioContext = AudioContextManager.getContext();

  // Create audio track
  const track = new AudioTrack({ audioContext });
  await track.initialize({
    noiseSuppression: false, // Disable native, we use RNNoise
    echoCancellation: true,
  });

  // Create and attach noise filter
  const noiseFilter = new NoiseFilterProcessor({
    noiseCancellation: true,
    noiseCancellationLevel: 'medium',
  });

  await track.setProcessor(noiseFilter);

  // The track.mediaStreamTrack now has noise-filtered audio
  return track;
}
```

### Using Factory Function

```typescript
import { createNoiseFilter } from '@arcaai/noise-filter';

const noiseFilter = createNoiseFilter({
  noiseCancellation: true,
  noiseCancellationLevel: 'high',
  autoGainControl: true,
  echoCancellation: true,
});

// Attach to track
await audioTrack.setProcessor(noiseFilter);

// Adjust level dynamically
await noiseFilter.setNoiseLevel('medium');

// Check stats
const stats = noiseFilter.getStats();
console.log(stats);
```

## API Reference

### NoiseFilterProcessor

Main processor class that extends `BaseProcessor` from `@arcaai/room`.

#### Constructor Options

```typescript
interface NoiseFilterOptions {
  // Enable AI-powered noise cancellation (default: true)
  noiseCancellation?: boolean;

  // Noise cancellation intensity: 'low' | 'medium' | 'high' (default: 'medium')
  noiseCancellationLevel?: NoiseCancellationLevel;

  // Enable echo cancellation via WebRTC native (default: true)
  echoCancellation?: boolean;

  // Enable auto gain control via WebRTC native (default: true)
  autoGainControl?: boolean;

  // Custom path to RNNoise WASM files (optional)
  wasmPath?: string;

  // Processing mode: 'quality' | 'performance' (default: 'quality')
  processingMode?: ProcessingMode;

  // Sample rate in Hz (default: 48000)
  sampleRate?: number;

  // Enable statistics emission (default: false)
  enableStats?: boolean;

  // Stats emission interval in ms (default: 1000)
  statsInterval?: number;

  // Debug mode — log noise filter config on initialization
  debugMode?: boolean;     // Default: false
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `setNoiseLevel(level)` | Set noise cancellation intensity |
| `getNoiseLevel()` | Get current noise level |
| `getStats()` | Get current processing statistics |
| `isUsingFallback()` | Check if using fallback mode |
| `updateOptions(options)` | Update options dynamically |
| `enable()` | Enable the processor |
| `disable()` | Disable the processor |
| `destroy()` | Clean up and release resources |

#### Events

```typescript
// Listen for noise stats
noiseFilter.on('data', (payload) => {
  if (payload.type === 'noise-stats') {
    const stats: NoiseFilterStats = payload.data;
    console.log('Active:', stats.isActive);
    console.log('Noise Reduction:', stats.noiseReductionDb, 'dB');
    console.log('VAD Probability:', stats.vadProbability);
    console.log('Latency:', stats.latencyMs, 'ms');
    console.log('CPU Load:', stats.cpuLoad);
  }
});

// Standard processor events
noiseFilter.on('ready', () => console.log('Processor ready'));
noiseFilter.on('enabled', () => console.log('Processor enabled'));
noiseFilter.on('disabled', () => console.log('Processor disabled'));
noiseFilter.on('error', (payload) => console.error(payload.error));
```

### Statistics

```typescript
interface NoiseFilterStats {
  isActive: boolean;        // Whether noise cancellation is active
  noiseReductionDb: number; // Estimated noise reduction in dB
  vadProbability: number;   // Voice Activity Detection confidence (0-1)
  latencyMs: number;        // Processing latency in ms
  framesProcessed: number;  // Total frames processed
  framesDropped: number;    // Frames dropped due to lag
  cpuLoad: number;          // CPU load estimate (0-1)
  timestamp: number;        // Stats collection timestamp
}
```

### Browser Support Utilities

```typescript
import {
  isRNNoiseSupported,
  getNoiseFilterBrowserSupport,
  logBrowserSupport,
} from '@arcaai/noise-filter';

// Check if RNNoise is supported
if (isRNNoiseSupported()) {
  console.log('Full RNNoise support available');
}

// Get detailed support info
const support = getNoiseFilterBrowserSupport();
console.log('WebAssembly:', support.webAssembly);
console.log('AudioWorklet:', support.audioWorklet);
console.log('RNNoise Supported:', support.rnnoiseSupported);
console.log('Native Fallback:', support.nativeFallbackAvailable);

// Log support info for debugging
logBrowserSupport();
```

## Browser Support

| Browser | RNNoise | AudioWorklet | Fallback |
|---------|---------|--------------|----------|
| Chrome 66+ | Full | Yes | Yes |
| Firefox 76+ | Full | Yes | Yes |
| Safari 17.4+ | Full | Yes | Yes |
| Safari < 17.4 | Partial | No | Yes |
| Edge 79+ | Full | Yes | Yes |

### Fallback Behavior

When AudioWorklet is not supported:
1. **ScriptProcessorNode**: Falls back to deprecated but widely-supported ScriptProcessor
2. **Native NS**: Falls back to WebRTC native noise suppression if RNNoise fails

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 NoiseFilterProcessor                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ MediaStream  │───▶│ AudioWorklet │───▶│   Processed  │  │
│  │   Source     │    │   (RNNoise)  │    │    Output    │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                              │                              │
│                              ▼                              │
│                      ┌──────────────┐                       │
│                      │ RNNoise WASM │                       │
│                      │   (480-sample│                       │
│                      │    frames)   │                       │
│                      └──────────────┘                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## RNNoise Technology

RNNoise is a noise suppression library that combines traditional signal processing with deep learning:

- **Model Size**: ~85KB WASM binary
- **Frame Size**: 480 samples (10ms at 48kHz)
- **Latency**: ~10ms algorithmic delay
- **CPU Usage**: Very low (~1-2% on modern CPUs)

It excels at removing:
- Keyboard typing
- Fan and AC noise
- Background chatter
- Traffic noise
- Humming and buzzing

## Performance Tips

1. **Use AudioWorklet**: Ensure AudioWorklet is supported for best performance
2. **Sample Rate**: Use 48kHz for optimal RNNoise performance
3. **Mobile Devices**: Consider using `processingMode: 'performance'`
4. **Stats Interval**: Increase `statsInterval` if you don't need frequent updates

## Debug Mode

Set `debugMode: true` to log noise filter configuration on initialization:

```typescript
const nf = new NoiseFilterProcessor({
  debugMode: true,
  noiseCancellation: true,
  noiseCancellationLevel: 'high',
});
```

Logs the full noise filter configuration (level, processing mode, sample rate, echo cancellation, AGC) to the console with `[ARCAAI:DEBUG]` prefix. When used via `@arcaai/vox` with `debug: true`, this is enabled automatically.

## License

MIT
