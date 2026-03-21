# @arcaai/vad

Voice Activity Detection plugin for `@arcaai/room` using Silero VAD v5. Provides accurate, real-time speech detection with configurable thresholds and timing parameters.

## Features

- **Silero VAD v5 Model**: State-of-the-art voice activity detection supporting 6000+ languages
- **Real-Time Processing**: Low-latency detection via AudioWorklet and ONNX Runtime WebAssembly
- **Configurable Thresholds**: Fine-tune detection sensitivity for your use case
- **Speech Segment Extraction**: Get audio data for detected speech segments
- **React Integration**: Easy-to-use `useVAD` hook for React applications
- **Event-Based API**: Subscribe to speech start/end events
- **Statistics Monitoring**: Real-time stats for debugging and UI feedback
- **Full TypeScript Support**: Comprehensive type definitions

## Installation

```bash
pnpm add @arcaai/vad
# or
npm install @arcaai/vad
# or
yarn add @arcaai/vad
```

## Requirements

- `@arcaai/room` ^0.1.0 (peer dependency)
- Browser with WebAssembly and AudioWorklet support
- React 18+ (optional, for hook usage)

## Quick Start

### With React Hooks

```tsx
import { RoomProvider, useAudioTrack } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

function App() {
  return (
    <RoomProvider>
      <VoiceRecorder />
    </RoomProvider>
  );
}

function VoiceRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
    echoCancellation: true,
  });

  const {
    isSpeaking,
    speechProbability,
    stats,
    isActive,
  } = useVAD({
    track,
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    minSpeechMs: 250,
    autoAttach: true,
    onSpeechStart: () => {
      console.log('Speech started');
    },
    onSpeechEnd: (audio) => {
      console.log('Speech ended, got', audio.length, 'samples at 16kHz');
      // Send to transcription service
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start Recording'}
      </button>

      <div>VAD Active: {isActive ? 'Yes' : 'No'}</div>
      <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
      <div>Probability: {(speechProbability * 100).toFixed(1)}%</div>
      <div>Speech Segments: {stats?.speechSegmentsDetected ?? 0}</div>
    </div>
  );
}
```

### With AudioTrack Directly

```typescript
import { AudioTrack, AudioContextManager } from '@arcaai/room';
import { VADProcessor } from '@arcaai/vad';

async function setupVAD() {
  // Get AudioContext
  const audioContext = AudioContextManager.getContext();

  // Create audio track
  const track = new AudioTrack({ audioContext });
  await track.initialize({
    noiseSuppression: true,
    echoCancellation: true,
  });

  // Create VAD processor
  const vad = new VADProcessor({
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    minSpeechMs: 250,
  });

  // Listen for speech events
  vad.on('data', (payload) => {
    switch (payload.type) {
      case 'vad-speech-start':
        console.log('Speech started at', payload.data.timestamp);
        break;

      case 'vad-speech-end':
        console.log('Speech ended:', {
          segment: payload.data.segmentNumber,
          durationSec: payload.data.durationSec,
          streamStart: payload.data.streamStartSec,
          streamEnd: payload.data.streamEndSec,
          samples: payload.data.audio.length,
        });
        // payload.data.audio is Float32Array at 16kHz
        break;

      case 'vad-frame':
        // Per-frame probability updates
        console.log('Speech probability:', payload.data.probability);
        break;
    }
  });

  // Attach VAD to track
  await track.setProcessor(vad);

  return { track, vad };
}
```

### Using Factory Function

```typescript
import { createVAD } from '@arcaai/vad';

const vad = createVAD({
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 250,
  preSpeechPadMs: 300,
  onSpeechEnd: (audio) => {
    // Process speech segment
    sendToTranscription(audio);
  },
});

// Attach to track
await audioTrack.setProcessor(vad);

// Check state
console.log('Speaking:', vad.isSpeaking());
console.log('Stats:', vad.getStats());

// Cleanup
await vad.destroy();
```

## API Reference

### VADProcessor

Main processor class that extends `BaseProcessor` from `@arcaai/room`.

#### Constructor Options

```typescript
interface VADOptions {
  // Model Selection
  model?: 'v5' | 'legacy';              // Default: 'v5'

  // Detection Thresholds
  positiveSpeechThreshold?: number;     // Default: 0.5 (0-1)
  negativeSpeechThreshold?: number;     // Default: 0.35 (0-1)

  // Timing (in milliseconds)
  preSpeechPadMs?: number;              // Default: 300
  postSpeechPadMs?: number;             // Default: 300
  minSpeechMs?: number;                 // Default: 250
  redemptionMs?: number;                // Default: 1400

  // Asset Paths (optional, uses CDN by default)
  baseAssetPath?: string;
  onnxWASMBasePath?: string;

  // Processing Options
  sampleRate?: number;                  // Default: 16000
  enableStats?: boolean;                // Default: false
  statsInterval?: number;               // Default: 1000ms
  submitUserSpeechOnPause?: boolean;    // Default: false

  // Debug mode — log VAD config on initialization
  debugMode?: boolean;                  // Default: false
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `isSupported()` | Check if VAD is supported in current browser |
| `isSpeaking()` | Check if currently detecting speech |
| `getSpeechProbability()` | Get current speech probability (0-1) |
| `getStats()` | Get current processing statistics |
| `getModel()` | Get the VAD model being used |
| `getOptions()` | Get current options |
| `updateOptions(options)` | Update options dynamically |
| `updateThresholds(pos, neg)` | Update detection thresholds |
| `pause()` | Pause VAD processing |
| `start()` | Resume VAD processing |
| `resetStats()` | Reset statistics counters |
| `enable()` | Enable the processor |
| `disable()` | Disable the processor |
| `destroy()` | Clean up and release resources |

#### Events

```typescript
// Speech start detected
vad.on('data', (payload) => {
  if (payload.type === 'vad-speech-start') {
    const { timestamp } = payload.data;
    console.log('Speech started at', timestamp);
  }
});

// Confirmed speech start (exceeds min speech duration)
vad.on('data', (payload) => {
  if (payload.type === 'vad-speech-real-start') {
    const { timestamp } = payload.data;
    console.log('Real speech confirmed at', timestamp);
  }
});

// Speech ended with audio data
vad.on('data', (payload) => {
  if (payload.type === 'vad-speech-end') {
    const { audio, startTime, endTime, duration } = payload.data;
    // audio is Float32Array at 16kHz sample rate
    console.log('Speech segment:', duration, 'ms');
  }
});

// Misfire (speech too short)
vad.on('data', (payload) => {
  if (payload.type === 'vad-misfire') {
    const { duration, timestamp } = payload.data;
    console.log('VAD misfire, speech was only', duration, 'ms');
  }
});

// Per-frame probability
vad.on('data', (payload) => {
  if (payload.type === 'vad-frame') {
    const { isSpeech, probability, notSpeechProbability, timestamp } = payload.data;
    // Update UI with probability
  }
});

// Statistics (if enableStats: true)
vad.on('data', (payload) => {
  if (payload.type === 'vad-stats') {
    const stats = payload.data;
    console.log('Frames processed:', stats.framesProcessed);
    console.log('Speech segments:', stats.speechSegmentsDetected);
  }
});

// Standard processor events
vad.on('ready', () => console.log('VAD ready'));
vad.on('enabled', () => console.log('VAD enabled'));
vad.on('disabled', () => console.log('VAD disabled'));
vad.on('error', (payload) => console.error(payload.error));
```

### useVAD Hook

React hook for VAD integration.

```typescript
const {
  // State
  isActive,
  isSpeaking,
  speechProbability,
  currentSpeechDuration,
  stats,
  processor,
  isAttached,
  error,

  // Actions
  attach,
  detach,
  pause,
  resume,
  resetStats,
  updateOptions,
} = useVAD({
  track,                    // AudioTrack from useAudioTrack
  autoAttach: true,         // Auto-attach when track available
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  onSpeechStart: () => {},
  onSpeechEnd: (audio) => {},
  onVADMisfire: () => {},
  onFrameProcessed: (probs, frame) => {},
});
```

### Statistics

```typescript
interface VADStats {
  isActive: boolean;              // Whether VAD is processing
  isSpeaking: boolean;            // Current speech state
  speechProbability: number;      // Current probability (0-1)
  currentSpeechDuration: number;  // Duration of current speech (ms)
  framesProcessed: number;        // Total frames processed
  speechSegmentsDetected: number; // Number of speech segments
  misfireCount: number;           // Number of misfires
  averageSpeechProbability: number; // Average probability
  timestamp: number;              // Stats collection time
}
```

### Browser Support Utilities

```typescript
import {
  isVADSupported,
  getVADBrowserSupport,
  getRecommendedModel,
  logVADBrowserSupport,
} from '@arcaai/vad';

// Quick check
if (isVADSupported()) {
  console.log('VAD is supported');
}

// Detailed support info
const support = getVADBrowserSupport();
console.log('WebAssembly:', support.webAssembly);
console.log('AudioWorklet:', support.audioWorklet);
console.log('SharedArrayBuffer:', support.sharedArrayBuffer);
console.log('VAD Supported:', support.vadSupported);
console.log('Recommended Model:', support.recommendedModel);

// Get recommended model for current browser
const model = getRecommendedModel(); // 'v5' or 'legacy'

// Log support info for debugging
logVADBrowserSupport();
```

## Browser Support

| Browser | VAD Support | AudioWorklet | Notes |
|---------|------------|--------------|-------|
| Chrome 66+ | Full | Yes | Recommended |
| Firefox 76+ | Full | Yes | - |
| Safari 17.4+ | Full | Yes | AudioWorklet support |
| Safari < 17.4 | Partial | No | Falls back to legacy model |
| Edge 79+ | Full | Yes | Chromium-based |
| iOS Safari | Partial | Varies | Use legacy model |

### Cross-Origin Isolation

For optimal performance with multi-threaded ONNX Runtime, enable cross-origin isolation:

```javascript
// vite.config.js
export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

## Model Configuration

### Silero VAD v5 (Recommended)

- **Frame Size**: 512 samples
- **Sample Rate**: 16kHz
- **Languages**: 6000+ supported
- **Performance**: Better accuracy in noisy environments

```typescript
const vad = new VADProcessor({
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
});
```

### Legacy Model

- **Frame Size**: 1536 samples
- **Sample Rate**: 16kHz
- **Compatibility**: Broader browser support

```typescript
const vad = new VADProcessor({
  model: 'legacy',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
});
```

## Timing Parameters

### preSpeechPadMs
Amount of audio to include before detected speech start. Helps capture initial low-energy speech sounds.

### postSpeechPadMs
Amount of audio to include after detected speech end. Helps capture trailing speech.

### minSpeechMs
Minimum duration for a segment to be considered valid speech. Shorter segments trigger `onVADMisfire`.

### redemptionMs
Duration of consecutive non-speech required to conclude speech has ended.

## Integration with Transcription

```typescript
import { useAudioTrack } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

function TranscriptionApp() {
  const { track, startCapture, stopCapture, isCapturing } = useAudioTrack({
    noiseSuppression: true,
  });

  const [transcripts, setTranscripts] = useState<string[]>([]);

  const { isSpeaking, speechProbability } = useVAD({
    track,
    model: 'v5',
    minSpeechMs: 300,
    onSpeechEnd: async (audio) => {
      // audio is Float32Array at 16kHz
      // Send to your transcription API
      const transcript = await transcribe(audio);
      setTranscripts((prev) => [...prev, transcript]);
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <div>Speaking: {isSpeaking ? '🎤' : '⏸️'}</div>
      <div>Confidence: {(speechProbability * 100).toFixed(0)}%</div>
      <ul>
        {transcripts.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      VADProcessor                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ MediaStream  │───▶│   MicVAD     │───▶│   Events     │  │
│  │    Track     │    │ (vad-web)    │    │              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│          │                  │                    │          │
│          ▼                  ▼                    ▼          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Passthrough │    │ Silero VAD   │    │ SpeechStart  │  │
│  │    Audio     │    │  v5 ONNX     │    │ SpeechEnd    │  │
│  │              │    │  (512 frame) │    │ Frame Data   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Performance Tips

1. **Use v5 Model**: Better accuracy and smaller frame size
2. **Tune Thresholds**: Adjust for your audio environment
3. **Enable Cross-Origin Isolation**: For multi-threaded ONNX
4. **Use Noise Suppression**: Combine with `@arcaai/noise-filter`
5. **Debounce UI Updates**: Don't update on every frame

## Troubleshooting

### VAD not detecting speech
- Lower `positiveSpeechThreshold` (e.g., 0.3)
- Increase `preSpeechPadMs` to capture quieter speech starts
- Check if audio input is working with `useAudioLevel`

### Too many false positives
- Raise `positiveSpeechThreshold` (e.g., 0.7)
- Increase `minSpeechMs` to filter short noises
- Use `@arcaai/noise-filter` to reduce background noise

### Model loading issues on iOS
- Use `model: 'legacy'` for better compatibility
- Check CORS headers for model files

### AudioWorklet not available
- Safari < 17.4 doesn't support AudioWorklet
- The library falls back automatically when possible

## Debug Mode

Set `debugMode: true` to log VAD configuration on initialization:

```typescript
const vad = new VADProcessor({
  debugMode: true,
  model: 'v5',
  positiveSpeechThreshold: 0.5,
});
```

Logs the full VAD configuration (model, thresholds, timing parameters) to the console with `[ARCAAI:DEBUG]` prefix. When used via `@arcaai/vox` with `debug: true`, this is enabled automatically.

## License

MIT
