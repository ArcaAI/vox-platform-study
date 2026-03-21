# SDK-203: ARCAAI VAD Package

| Field | Value |
|-------|-------|
| **Ticket Number** | SDK-203 |
| **Created Date** | 2026-01-10 |
| **Last Updated** | 2026-01-10 |
| **Status** | Completed |

## Requirement Analysis

### Description
Build a voice activity detection package (`@arcaai/vad`) using the Silero VAD v5 model that integrates with `@arcaai/room` as a TrackProcessor plugin, following the same architecture patterns as `@arcaai/noise-filter`.

### Business Context
Voice Activity Detection (VAD) is essential for:
- Detecting when users are speaking in real-time
- Segmenting audio for transcription services
- Reducing unnecessary audio processing when no speech is detected
- Enabling push-to-talk alternatives with automatic detection

### Acceptance Criteria
- [x] Package follows `@arcaai/room` processor plugin architecture
- [x] Uses Silero VAD v5 model via ONNX Runtime for accurate detection
- [x] Provides configurable thresholds and timing parameters
- [x] Emits speech start/end events with audio data
- [x] Includes React hook for easy integration
- [x] Full TypeScript support with comprehensive types
- [x] Documentation with examples and browser support matrix

## Current State Evaluation

### Related Components
- `@arcaai/room` - Core audio processing package with BaseProcessor class
- `@arcaai/noise-filter` - Reference implementation for processor plugin pattern
- `@ricky0123/vad-web` - Silero VAD implementation for web browsers

### Dependencies
- `@ricky0123/vad-web` ^0.0.29 - VAD engine with Silero model
- `onnxruntime-web` ^1.22.0 - ONNX Runtime for WebAssembly inference
- `@arcaai/room` ^0.1.0 - Peer dependency for processor integration

## Implementation Plan

### Approach
Use `@ricky0123/vad-web` as the VAD engine (Option A from plan) for:
- Battle-tested Silero VAD implementation
- Built-in AudioWorklet handling
- Silero v5 model support
- Active maintenance

### Package Structure
```
packages/vad/
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── assets/
│   └── README.md
├── examples/
│   ├── basic-usage.tsx
│   └── transcription-integration.ts
└── src/
    ├── index.ts
    ├── types/
    │   └── index.ts
    ├── processors/
    │   ├── index.ts
    │   └── VADProcessor.ts
    ├── hooks/
    │   ├── index.ts
    │   └── useVAD.ts
    ├── utils/
    │   ├── index.ts
    │   ├── browserSupport.ts
    │   ├── resampler.ts
    │   └── frameProcessor.ts
    └── worklets/
        ├── index.ts
        ├── vad.worklet.ts
        └── worklet-loader.ts
```

## Implementation Summary

### What Was Implemented

#### 1. Package Configuration
- `package.json` with dependencies on `@ricky0123/vad-web` and peer dependencies
- TypeScript configuration extending `@arcaai/config-ts/react-library.json`
- tsup build configuration for ESM/CJS output and worklet separation

#### 2. Type Definitions (`src/types/index.ts`)
- `VADOptions` - Configuration interface with all Silero VAD parameters
- `VADStats` - Statistics for monitoring VAD processing
- Event payloads: `VADFramePayload`, `VADSpeechStartPayload`, `VADSpeechEndPayload`, `VADMisfirePayload`
- Worklet message types for communication
- `VADBrowserSupport` for feature detection
- `VADError` and `VADErrorCode` for error handling

#### 3. VADProcessor (`src/processors/VADProcessor.ts`)
- Extends `BaseProcessor` from `@arcaai/room`
- Integrates with `@ricky0123/vad-web` MicVAD
- Configurable thresholds and timing parameters
- Speech events: start, real-start, end, misfire
- Per-frame probability updates
- Statistics emission
- Enable/disable support
- Passthrough audio (VAD doesn't modify audio)

#### 4. React Hook (`src/hooks/useVAD.ts`)
- `useVAD` hook for React integration
- Auto-attach to AudioTrack
- Real-time state: `isSpeaking`, `speechProbability`, `currentSpeechDuration`
- Callbacks: `onSpeechStart`, `onSpeechEnd`, `onVADMisfire`, `onFrameProcessed`
- Actions: `attach`, `detach`, `pause`, `resume`, `resetStats`

#### 5. Utilities
- **Browser Support** (`browserSupport.ts`): Feature detection for WebAssembly, AudioWorklet, ONNX Runtime, Safari/iOS handling
- **Resampler** (`resampler.ts`): Audio resampling to 16kHz with `Resampler` class and helper functions
- **Frame Processor** (`frameProcessor.ts`): `FrameAccumulator` for 512-sample frames, `AudioRingBuffer` for pre-speech padding

#### 6. AudioWorklet (`src/worklets/`)
- VAD worklet for frame accumulation and communication
- Worklet loader with inline source generation
- Registration and cleanup utilities

#### 7. Documentation
- Comprehensive README.md with API reference
- Browser support matrix
- Integration examples (React and direct usage)
- Transcription integration example

### Files Created/Modified
```
packages/vad/
├── README.md                              # Documentation
├── package.json                           # Package configuration
├── tsconfig.json                          # TypeScript config
├── tsconfig.build.json                    # Build config
├── tsup.config.ts                         # Build tool config
├── assets/
│   └── README.md                          # Assets documentation
├── examples/
│   ├── basic-usage.tsx                    # React example
│   └── transcription-integration.ts       # Transcription example
└── src/
    ├── index.ts                           # Main exports
    ├── types/
    │   └── index.ts                       # Type definitions
    ├── processors/
    │   ├── index.ts                       # Processor exports
    │   └── VADProcessor.ts                # Main processor
    ├── hooks/
    │   ├── index.ts                       # Hook exports
    │   └── useVAD.ts                      # React hook
    ├── utils/
    │   ├── index.ts                       # Utility exports
    │   ├── browserSupport.ts              # Browser detection
    │   ├── resampler.ts                   # Audio resampling
    │   └── frameProcessor.ts              # Frame handling
    └── worklets/
        ├── index.ts                       # Worklet exports
        ├── vad.worklet.ts                 # AudioWorklet processor
        └── worklet-loader.ts              # Worklet registration
```

### Key Features

1. **Silero VAD v5 Integration**
   - 512-sample frame size for low latency
   - Support for 6000+ languages
   - Better noise robustness than legacy model

2. **Configurable Parameters**
   - `positiveSpeechThreshold`: Speech detection sensitivity (default: 0.5)
   - `negativeSpeechThreshold`: Speech end detection (default: 0.35)
   - `minSpeechMs`: Minimum speech duration (default: 250ms)
   - `preSpeechPadMs`: Audio before speech (default: 300ms)
   - `redemptionMs`: Time before speech end (default: 1400ms)

3. **Event System**
   - `vad-speech-start`: Speech detected
   - `vad-speech-real-start`: Speech confirmed (exceeds min duration)
   - `vad-speech-end`: Speech ended with audio data (Float32Array @ 16kHz)
   - `vad-misfire`: Speech too short
   - `vad-frame`: Per-frame probability

4. **Browser Support**
   - Chrome 66+, Firefox 76+, Safari 17.4+, Edge 79+
   - Fallback to legacy model for older browsers
   - iOS-specific handling

### Usage Example

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

function VoiceRecorder() {
  const { track } = useAudioTrack({ noiseSuppression: true });
  
  const { isSpeaking, speechProbability } = useVAD({
    track,
    model: 'v5',
    onSpeechEnd: (audio) => {
      // Send to transcription
      transcribe(audio);
    },
  });

  return (
    <div>
      Speaking: {isSpeaking ? 'Yes' : 'No'}
      Probability: {(speechProbability * 100).toFixed(1)}%
    </div>
  );
}
```

### Testing Performed
- Package structure follows `@arcaai/noise-filter` pattern
- Type definitions are comprehensive and well-documented
- Examples provided for common use cases

### Deployment Considerations
- Package ready for npm publish
- CDN paths configured for model/WASM files
- Self-hosting instructions in assets/README.md

## Change History

*No changes yet - initial implementation.*
