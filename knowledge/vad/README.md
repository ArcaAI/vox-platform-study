# VAD (`@arcaai/vad`)

Voice Activity Detection plugin for [`@arcaai/room`](../room/README.md) using Silero VAD v5. Provides accurate, real-time speech detection with configurable thresholds and timing parameters.

## Overview

`@arcaai/vad` detects when a user is speaking by running the Silero VAD v5 model through ONNX Runtime WebAssembly. It operates as a `TrackProcessor` plugin for `@arcaai/room`, analyzing audio frames in real-time and emitting speech start/end events with the captured audio segment. The extracted speech audio (at 16 kHz) can be fed directly to `@arcaai/stt` for transcription.

The processor is passthrough — it does not modify the audio stream, only analyzes it.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      VADProcessor                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  MediaStream ──► MicVAD (vad-web) ──► Events                │
│     Track        │                    │                      │
│                  ▼                    ▼                      │
│  Passthrough   Silero VAD v5       SpeechStart              │
│    Audio       ONNX Runtime        SpeechEnd (+ audio data) │
│                512-sample frames   Frame probability         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @arcaai/vad
```

### Peer Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@arcaai/room` | `^0.1.0` | Audio track and processor infrastructure |

### Runtime Requirements

- WebAssembly support
- AudioWorklet support (Safari 17.4+; falls back to legacy model on older browsers)
- React `^18.3.0 || ^19.0.4` (optional, for hook usage)

## API Reference

### VADProcessor

Main processor class extending `BaseProcessor` from `@arcaai/room`.

| Method | Type | Description |
|--------|------|-------------|
| `isSupported()` | `() => boolean` | Browser support check |
| `isSpeaking()` | `() => boolean` | Current speech state |
| `getSpeechProbability()` | `() => number` | Current probability 0–1 |
| `getStats()` | `() => VADStats` | Processing statistics |
| `getModel()` | `() => 'v5' \| 'legacy'` | Active model |
| `getOptions()` | `() => VADOptions` | Current options |
| `updateOptions(options)` | `(Partial<VADOptions>) => void` | Update options dynamically |
| `updateThresholds(pos, neg)` | `(number, number) => void` | Update detection thresholds |
| `pause()` | `() => void` | Pause processing |
| `start()` | `() => void` | Resume processing |
| `resetStats()` | `() => void` | Reset statistics |
| `enable()` | `() => Promise<void>` | Enable processor |
| `disable()` | `() => Promise<void>` | Disable processor |
| `destroy()` | `() => Promise<void>` | Clean up resources |

### createVAD (Factory)

```typescript
import { createVAD } from '@arcaai/vad';

const vad = createVAD({
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  minSpeechMs: 250,
  onSpeechEnd: (audio) => sendToTranscription(audio),
});

await audioTrack.setProcessor(vad);
```

### useVAD (Hook)

```typescript
import { useVAD } from '@arcaai/vad';

const {
  isActive,
  isSpeaking,
  speechProbability,
  currentSpeechDuration,
  stats,
  processor,
  isAttached,
  error,
  attach,
  detach,
  pause,
  resume,
  resetStats,
  updateOptions,
} = useVAD({
  track,
  autoAttach: true,
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  onSpeechStart: () => console.log('Speaking'),
  onSpeechEnd: (audio) => console.log('Segment:', audio.length, 'samples'),
  onVADMisfire: () => console.log('Too short'),
  onFrameProcessed: (probs, frame) => {},
});
```

| Property | Type | Description |
|----------|------|-------------|
| `isActive` | `boolean` | Whether VAD is processing |
| `isSpeaking` | `boolean` | Speech detected |
| `speechProbability` | `number` | Current probability 0–1 |
| `currentSpeechDuration` | `number` | Duration of current speech (ms) |
| `stats` | `VADStats \| null` | Processing statistics |
| `processor` | `VADProcessor \| null` | Underlying processor |
| `isAttached` | `boolean` | Whether attached to a track |
| `error` | `Error \| null` | Error state |

## Configuration

### VADOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `'v5' \| 'legacy'` | `'v5'` | VAD model to use |
| `positiveSpeechThreshold` | `number` | `0.5` | Probability threshold to start speech (0–1) |
| `negativeSpeechThreshold` | `number` | `0.35` | Probability threshold to end speech (0–1) |
| `preSpeechPadMs` | `number` | `300` | Audio to include before speech start (ms) |
| `postSpeechPadMs` | `number` | `300` | Audio to include after speech end (ms) |
| `minSpeechMs` | `number` | `250` | Minimum speech duration; shorter triggers misfire (ms) |
| `redemptionMs` | `number` | `1400` | Consecutive non-speech required to end speech (ms) |
| `sampleRate` | `number` | `16000` | Internal processing sample rate |
| `enableStats` | `boolean` | `false` | Emit statistics events |
| `statsInterval` | `number` | `1000` | Stats emission interval (ms) |
| `submitUserSpeechOnPause` | `boolean` | `false` | Emit in-progress speech on pause |
| `baseAssetPath` | `string?` | CDN | Custom path for model assets |
| `onnxWASMBasePath` | `string?` | CDN | Custom path for ONNX WASM files |

### Timing Parameters Explained

| Parameter | Purpose |
|-----------|---------|
| `preSpeechPadMs` | Captures initial low-energy speech sounds that precede the threshold crossing |
| `postSpeechPadMs` | Captures trailing speech after the probability drops below threshold |
| `minSpeechMs` | Filters out non-speech transients (clicks, coughs). Segments shorter than this trigger `vad-misfire` |
| `redemptionMs` | Prevents premature speech-end during natural pauses. Higher values tolerate longer mid-speech silences |

### Events

| Event Type | Payload | Description |
|------------|---------|-------------|
| `vad-speech-start` | `{ timestamp }` | Speech probability exceeded threshold |
| `vad-speech-real-start` | `{ timestamp }` | Speech confirmed (exceeds `minSpeechMs`) |
| `vad-speech-end` | `{ audio, startTime, endTime, duration }` | Speech ended; `audio` is `Float32Array` at 16 kHz |
| `vad-misfire` | `{ duration, timestamp }` | Speech was shorter than `minSpeechMs` |
| `vad-frame` | `{ isSpeech, probability, notSpeechProbability, timestamp }` | Per-frame probability update |
| `vad-stats` | `VADStats` | Processing statistics (when `enableStats: true`) |

### VADStats

| Property | Type | Description |
|----------|------|-------------|
| `isActive` | `boolean` | Processing state |
| `isSpeaking` | `boolean` | Current speech state |
| `speechProbability` | `number` | Current probability |
| `currentSpeechDuration` | `number` | Duration of current speech (ms) |
| `framesProcessed` | `number` | Total frames processed |
| `speechSegmentsDetected` | `number` | Number of speech segments |
| `misfireCount` | `number` | Number of misfires |
| `averageSpeechProbability` | `number` | Average probability |
| `timestamp` | `number` | Timestamp when stats were collected |

## Model Configuration

### Silero VAD v5 (Recommended)

- Frame size: 512 samples
- Sample rate: 16 kHz
- Languages: 6000+ supported
- Better accuracy in noisy environments

### Legacy Model

- Frame size: 1536 samples
- Sample rate: 16 kHz
- Broader browser compatibility (no AudioWorklet required)

Use `getRecommendedModel()` to select the best model for the current browser.

## Browser Support

| Browser | VAD Support | AudioWorklet | Notes |
|---------|------------|--------------|-------|
| Chrome 66+ | Full | Yes | Recommended |
| Firefox 76+ | Full | Yes | — |
| Safari 17.4+ | Full | Yes | AudioWorklet supported |
| Safari < 17.4 | Partial | No | Falls back to legacy model |
| Edge 79+ | Full | Yes | Chromium-based |
| iOS Safari | Partial | Varies | Use legacy model |

```typescript
import { isVADSupported, getVADBrowserSupport, getRecommendedModel } from '@arcaai/vad';

if (isVADSupported()) {
  const support = getVADBrowserSupport();
  console.log('WebAssembly:', support.webAssembly);
  console.log('AudioWorklet:', support.audioWorklet);
  console.log('Recommended model:', support.recommendedModel);
}
```

### Cross-Origin Isolation

For optimal multi-threaded ONNX Runtime performance:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

## Integration with Transcription

VAD detects speech segments and provides the audio data that can be sent to `@arcaai/stt` for transcription:

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

function TranscriptionApp() {
  const { track, startCapture, isCapturing } = useAudioTrack({ noiseSuppression: true });
  const [transcripts, setTranscripts] = useState<string[]>([]);

  const { isSpeaking, speechProbability } = useVAD({
    track,
    model: 'v5',
    minSpeechMs: 300,
    onSpeechEnd: async (audio) => {
      const transcript = await transcribe(audio);
      setTranscripts((prev) => [...prev, transcript]);
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? undefined : startCapture}>Start</button>
      <p>Speaking: {isSpeaking ? 'Yes' : 'No'}</p>
      <p>Confidence: {(speechProbability * 100).toFixed(0)}%</p>
      <ul>{transcripts.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
```
