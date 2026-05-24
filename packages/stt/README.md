# @arcaai/stt

Speech-to-text plugin for `@arcaai/room` with local Whisper processing and remote WebSocket support.

## Features

- **Local Whisper Processing**: Run OpenAI's Whisper model directly in the browser via Transformers.js
- **WebGPU Acceleration**: Automatic GPU acceleration when available
- **Remote Processing**: WebSocket-based streaming to server-side processing
- **Multiple Model Sizes**: Support for tiny, base, small, medium, and large models
- **Multilingual Support**: Transcription in 99+ languages with ISO locale codes
- **Timestamp Support**: Chunk-level and word-level timestamps
- **Speaker Diarization**: Support for multi-speaker transcription
- **Integration Ready**: Seamless integration with `@arcaai/room` processor pipeline

## Installation

```bash
pnpm add @arcaai/stt
# or
npm install @arcaai/stt
# or
yarn add @arcaai/stt
```

## Quick Start

### Basic Usage with React

```tsx
import { useEffect, useState } from 'react';
import { RoomProvider, useAudioTrack, useProcessors } from '@arcaai/room';
import { createSTT } from '@arcaai/stt';

function TranscriptionDemo() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
    echoCancellation: true,
  });
  const { addProcessor, removeProcessor } = useProcessors({ track });
  const [transcription, setTranscription] = useState('');

  useEffect(() => {
    if (track) {
      const stt = createSTT({
        sttSocket: 'wss://your-api.com/ws/stt',
        audio: {
          language: 'en-US',
        },
        features: {
          provider: 'remote',
          diarization: true,
        },
      });

      stt.on('data', (payload) => {
        if (payload.type === 'stt-transcription') {
          setTranscription((prev) => prev + ' ' + payload.data.text);
        }
      });

      addProcessor(stt);

      return () => {
        removeProcessor(stt);
      };
    }
  }, [track]);

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start Recording'}
      </button>
      <div>
        <h3>Transcription:</h3>
        <p>{transcription}</p>
      </div>
    </div>
  );
}

function App() {
  return (
    <RoomProvider>
      <TranscriptionDemo />
    </RoomProvider>
  );
}
```

### Using the useSTT Hook (Recommended)

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useSTT } from '@arcaai/stt';

function Transcriber() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
  });

  const {
    isReady,
    isProcessing,
    currentTranscript,
    finalTranscripts,
    stats,
    error,
    clear,
  } = useSTT({
    track,
    sttSocket: 'wss://your-api.com/ws/stt',
    autoAttach: true,
    audio: { language: 'en-US' },
    features: { provider: 'remote' },
    onTranscription: (result) => {
      console.log('Final transcription:', result.text);
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <div>Status: {isProcessing ? 'Processing...' : 'Idle'}</div>
      <div>Current: {currentTranscript}</div>
      <ul>
        {finalTranscripts.map((t, i) => (
          <li key={i}>{t.text}</li>
        ))}
      </ul>
      {error && <div className="error">{error.message}</div>}
    </div>
  );
}
```

The `useSTT` hook provides:
- **State management**: `isReady`, `isProcessing`, `isLoading`, `currentTranscript`, `finalTranscripts`
- **Model loading**: `loadProgress` for tracking model download (local provider)
- **Statistics**: `stats` with processing metrics
- **Methods**: `attach`, `detach`, `transcribeSegment`, `clear`, `setLanguage`
- **Error handling**: `error` state with automatic error propagation

### Direct Processor Usage

```typescript
import { STTProcessor } from '@arcaai/stt';
import { AudioTrack } from '@arcaai/room';

// Create processor with local model
const stt = new STTProcessor({
  audio: {
    language: 'en-US',
    sampleRate: 16000,
    chunkLengthS: 30,
    overlapLengthS: 5,
  },
  features: {
    provider: 'local',
    modelId: 'tiny',
    device: 'auto',
    returnTimestamps: true,
  },
  onModelProgress: (progress) => {
    console.log(`Loading model: ${(progress.progress * 100).toFixed(0)}%`);
  },
});

// Listen for transcriptions
stt.on('data', (payload) => {
  switch (payload.type) {
    case 'stt-transcription':
      console.log('Final:', payload.data.text);
      break;
    case 'stt-partial':
      console.log('Partial:', payload.data.text);
      break;
    case 'stt-model-loaded':
      console.log('Model ready!', payload.data);
      break;
  }
});

// Attach to audio track
await audioTrack.setProcessor(stt);

// Later, cleanup
await stt.destroy();
```

### Remote Processing Mode

```typescript
import { createSTT } from '@arcaai/stt';

const stt = createSTT({
  sttSocket: 'wss://your-api.com/ws/stt',
  // sessionId is auto-generated if not provided
  audio: {
    language: 'en-US',
  },
  features: {
    provider: 'remote',
    diarization: true,
    numSpeakers: 2,
  },
});

stt.on('data', (payload) => {
  if (payload.type === 'stt-transcription') {
    console.log(`[${payload.data.speakerId}]: ${payload.data.text}`);
  }
});
```

## Configuration Options

```typescript
interface STTOptions {
  // WebSocket URL for remote STT service
  sttSocket?: string;

  // Session ID (auto-generated if not provided)
  sessionId?: string;

  // Audio source configuration
  audio?: {
    language?: string;        // ISO 639-1 + ISO 3166-1 (default: 'en-US')
    sampleRate?: number;      // Default: 16000
    channels?: number;        // Default: 1
    chunkLengthS?: number;    // Default: 30
    overlapLengthS?: number;  // Default: 5
  };

  // Feature flags
  features?: {
    provider?: 'local' | 'remote';  // Default: 'remote'
    modelId?: string;               // Required for local (e.g., 'tiny', 'base')
    diarization?: boolean;          // Default: false
    numSpeakers?: number;           // Default: 2
    returnTimestamps?: boolean | 'word';  // Default: true
    device?: 'webgpu' | 'wasm' | 'auto';  // Default: 'auto'
    quantized?: boolean;            // Default: true
  };

  // Initial prompt to guide transcription
  prompt?: string;

  // Stats and monitoring
  enableStats?: boolean;     // Default: false
  statsInterval?: number;    // Default: 1000ms

  // Callbacks
  onModelProgress?: (progress: ModelLoadProgress) => void;

  // Debug mode — log config on init and transcript JSON for each final result
  debugMode?: boolean;    // Default: false
}
```

## Language Support

Languages are specified using ISO 639-1 language code combined with ISO 3166-1 country code:

```typescript
// Common locale codes
const stt = createSTT({
  audio: {
    language: 'en-US',  // English (United States)
    // language: 'en-GB',  // English (United Kingdom)
    // language: 'es-ES',  // Spanish (Spain)
    // language: 'fr-FR',  // French (France)
    // language: 'de-DE',  // German (Germany)
    // language: 'zh-CN',  // Chinese (Simplified)
    // language: 'ja-JP',  // Japanese
    // language: 'ko-KR',  // Korean
  },
});
```

## Event Types

| Event Type | Description | Payload |
|------------|-------------|---------|
| `stt-transcription` | Final transcription result | `TranscriptionResult` |
| `stt-partial` | Interim transcription result | `TranscriptionResult` |
| `stt-model-loaded` | Model loaded (local only) | Model info |
| `stt-speech-start` | Speech segment started | Timestamp |
| `stt-speech-end` | Speech segment ended | Duration |
| `stt-stats` | Processing statistics | `STTStats` |

### TranscriptionResult

```typescript
interface TranscriptionResult {
  text: string;              // Transcribed text
  isFinal: boolean;          // Whether this is final
  language: string;          // Language locale code
  confidence?: number;       // Confidence score (0-1)
  timestamps?: TranscriptionTimestamp[];  // Segment/word timestamps
  speakerId?: string;        // Speaker ID (with diarization)
  duration?: number;         // Audio duration in seconds
  latencyMs?: number;        // Processing latency
}
```

## Model Selection

| Model | Size | Speed | Accuracy | Use Case |
|-------|------|-------|----------|----------|
| `tiny` | ~40MB | Fastest | Good | Real-time, low-power devices |
| `base` | ~75MB | Fast | Better | Balanced performance |
| `small` | ~240MB | Medium | High | Quality-focused apps |
| `medium` | ~770MB | Slow | Very High | Professional use |
| `large` | ~1.5GB | Slowest | Best | Maximum accuracy |

For most web applications, `tiny` or `base` models are recommended for good real-time performance.

## Browser Support

| Browser | Local STT | Remote STT | Notes |
|---------|-----------|------------|-------|
| Chrome 113+ | Full | Full | WebGPU supported |
| Firefox 100+ | WASM only | Full | No WebGPU yet |
| Safari 17.4+ | WASM only | Full | AudioWorklet supported |
| Edge 113+ | Full | Full | Chromium-based |

### Multi-threaded ONNX Runtime (COOP/COEP) — TASK-300 L-9

The Whisper worker enables ONNX Runtime's multi-threaded WASM backend (via
`ort.env.wasm.numThreads = min(8, navigator.hardwareConcurrency)`) **only**
when the host page is cross-origin-isolated. Threaded inference depends on
`SharedArrayBuffer`, which the browser exposes solely to isolated contexts.

To opt in, the page that loads `@arcaai/stt` must be served with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(Or `credentialless` for COEP if you load third-party assets without CORP
headers — Chrome 96+, Firefox 110+.) Verify in DevTools by checking
`window.crossOriginIsolated === true`.

Without these headers the worker silently falls back to single-threaded
inference. This is the safe default — promoting `numThreads` without
isolation triggers an immediate `Error: Out of memory` from ORT.

The thread count is clamped at 8 because ORT's Whisper inference sees
diminishing returns past that point and can starve the rest of the page on
large CPUs. The same gating applies to `@arcaai/vad` (Silero VAD via ORT).

Check browser support programmatically:

```typescript
import { getSTTBrowserSupport, isSTTSupported, logBrowserSupport } from '@arcaai/stt';

const support = getSTTBrowserSupport();
console.log('Local STT supported:', support.localSupported);
console.log('Remote STT supported:', support.backendSupported);
console.log('Recommended provider:', support.recommendedProvider);
console.log('Recommended device:', support.recommendedDevice);

// Log all support info
logBrowserSupport();
```

## Advanced Usage

### Direct Provider Access

```typescript
import { LocalSTTProvider, WhisperEngine } from '@arcaai/stt';

// Use provider directly without processor
const provider = new LocalSTTProvider();

await provider.init({
  sessionId: 'my-session',
  modelId: 'small',
  language: 'en-US',
  device: 'webgpu',
  quantized: true,
  sampleRate: 16000,
  channels: 1,
  chunkLengthS: 30,
  overlapLengthS: 5,
  returnTimestamps: true,
  diarization: false,
  numSpeakers: 2,
});

provider.onTranscription((result) => {
  console.log(result.text);
});

await provider.start();

// Process audio manually
provider.processAudio(audioSamples, sampleRate);

await provider.stop();
await provider.destroy();
```

### Audio Buffer Management

```typescript
import { AudioBufferManager, WHISPER_SAMPLE_RATE } from '@arcaai/stt';

const bufferManager = new AudioBufferManager({
  chunkLengthS: 30,
  overlapLengthS: 5,
});

// Add audio samples
bufferManager.append(audioSamples, inputSampleRate);

// Check if a chunk is ready
if (bufferManager.hasChunk()) {
  const chunk = bufferManager.getChunk();
  // Process chunk with Whisper
}

// Get remaining audio at end
const remaining = bufferManager.flush();
```

## Pipeline Integration

The STT processor integrates with `@arcaai/room` processor pipeline for chained audio processing:

```typescript
import { VADProcessor } from '@arcaai/vad';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { STTProcessor, createSTT } from '@arcaai/stt';
import { ProcessorPipeline } from '@arcaai/room';

// Create processors
const vad = new VADProcessor();
const noiseFilter = new NoiseFilterProcessor();
const stt = createSTT({
  sttSocket: 'wss://api.example.com/ws/stt',
  features: { provider: 'remote' },
});

// Create pipeline: VAD -> Noise Filter -> STT
const pipeline = new ProcessorPipeline([vad, noiseFilter, stt]);

// Attach to audio track
await audioTrack.setProcessor(pipeline);
```

## Utilities

### Audio Resampling

```typescript
import {
  prepareFloat32ForWhisper,
  resampleLinear,
  int16ToFloat32,
  WHISPER_SAMPLE_RATE,
} from '@arcaai/stt';

// Resample any audio to 16kHz for Whisper
const resampled = prepareFloat32ForWhisper(audioSamples, originalSampleRate);

// Convert PCM to Float32
const float32 = int16ToFloat32(int16Array);
```

### Language Utilities

```typescript
import { getLanguageCode, getCountryCode } from '@arcaai/stt';

getLanguageCode('en-US');  // Returns 'en'
getCountryCode('en-US');   // Returns 'US'
```

## API Reference

### STTProcessor

Main processor class extending `BaseProcessor` from `@arcaai/room`.

```typescript
class STTProcessor extends BaseProcessor {
  constructor(options?: STTOptions);

  isSupported(): boolean;
  getProviderType(): 'local' | 'remote';
  getProvider(): STTProvider | null;
  getStats(): STTStats | null;
  getOptions(): STTOptions;
  getSessionId(): string;
  getLanguage(): string;

  transcribeSegment(audio: Float32Array): Promise<TranscriptionResult>;
  setLanguage(language: string): Promise<void>;
}
```

### Factory Function

```typescript
function createSTT(options?: STTOptions): STTProcessor;
```

### Session ID Generation

```typescript
import { generateSessionId } from '@arcaai/stt';

const sessionId = generateSessionId();
// Returns: 'stt-<timestamp>-<random>'
```

## Error Handling

```typescript
import { STTError, STTErrorCode } from '@arcaai/stt';

stt.on('error', (payload) => {
  const error = payload.error;

  if (error instanceof STTError) {
    switch (error.code) {
      case STTErrorCode.MODEL_LOAD_FAILED:
        console.error('Failed to load model');
        break;
      case STTErrorCode.WEBSOCKET_ERROR:
        console.error('WebSocket connection error');
        break;
      case STTErrorCode.NOT_SUPPORTED:
        console.error('STT not supported in this browser');
        break;
      case STTErrorCode.INVALID_CONFIG:
        console.error('Invalid configuration');
        break;
    }
  }
});
```

## Debug Mode

Set `debugMode: true` to enable verbose console logging:

```typescript
const stt = new STTProcessor({
  debugMode: true,
  features: { provider: 'local', modelId: 'base', returnTimestamps: 'word' },
});
```

When active, the processor logs:
1. **Configuration dump** on initialization (provider, model, language, features)
2. **Structured transcript JSON** for each final transcription result with precise formatting (times: 3 decimals, inference: 4 decimals, confidence: 3 decimals)

All output uses the `[ARCAAI:DEBUG]` prefix. When used via `@arcaai/vox` with `debug: true`, this is enabled automatically.

## License

MIT
