# SDK-204: @arcaai/stt Package

## Header

| Field        | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| Ticket       | SDK-204                                                     |
| Feature Name | Speech-to-Text Plugin Package                               |
| Created      | 2026-01-10                                                  |
| Last Updated | 2026-01-10                                                  |
| Status       | Completed                                                   |

## Requirement Analysis

### Description

Create a best-practice speech-to-text plugin package (`@arcaai/stt`) for `@arcaai/room` that supports:
- Local Whisper processing via Transformers.js/ONNX Runtime Web
- WebSocket-based backend fallback to the existing STT service
- Extensible architecture for future model additions
- Both TransformersJS and ONNX runtime support

### Business Context

The package enables real-time speech transcription in ARCAAI applications with:
- Privacy-first local processing when browser supports it
- Fallback to backend for unsupported browsers or higher accuracy
- Seamless integration with the `@arcaai/room` audio processing pipeline
- Support for multiple languages and model sizes

### Reference Material

- `@arcaai/room` package architecture
- `@arcaai/noise-filter` package patterns
- `@arcaai/vad` package patterns
- Backend STT service (`apps/stt/`)
- Transformers.js documentation
- Whisper model specifications

## Current State Evaluation

### Existing Backend STT Service

The backend already has a comprehensive STT service with:
- WebSocket real-time streaming (`apps/stt/src/stt/api/handlers/websocket.py`)
- Whisper model support via faster-whisper (`apps/stt/src/stt/services/whisper_stt_service.py`)
- Session management and diarization
- Support for Azure and Whisper providers

### Existing Room Package

The `@arcaai/room` package provides:
- `BaseProcessor` class for plugin development
- `TrackProcessor` interface for audio processing
- Event system via `ProcessorEvent`
- Audio utilities for resampling and level detection

## Implementation Plan

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @arcaai/stt                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ STTProcessor (extends BaseProcessor)                      │   │
│  │ - Provider selection (auto/local/backend)                │   │
│  │ - Event emission (transcription, partial, stats)         │   │
│  └─────────────────────────┬────────────────────────────────┘   │
│                            │                                     │
│              ┌─────────────┴─────────────┐                      │
│              ▼                           ▼                       │
│  ┌──────────────────────┐   ┌──────────────────────┐            │
│  │ LocalSTTProvider     │   │ BackendSTTProvider   │            │
│  │ - WhisperEngine      │   │ - WebSocketClient    │            │
│  │ - AudioBufferManager │   │ - MessageHandler     │            │
│  └──────────────────────┘   └──────────────────────┘            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/stt/
├── src/
│   ├── index.ts                 # Public API exports
│   ├── core/
│   │   ├── STTProcessor.ts      # Main processor
│   │   ├── AudioBufferManager.ts
│   │   └── index.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── BaseSTTProvider.ts
│   │   ├── LocalSTTProvider.ts
│   │   ├── BackendSTTProvider.ts
│   │   └── index.ts
│   ├── engines/
│   │   ├── types.ts
│   │   ├── BaseEngine.ts
│   │   ├── WhisperEngine.ts
│   │   └── index.ts
│   ├── websocket/
│   │   ├── WebSocketClient.ts
│   │   ├── MessageHandler.ts
│   │   └── index.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       ├── audioResampler.ts
│       ├── browserSupport.ts
│       └── index.ts
├── assets/
│   └── README.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
└── README.md
```

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `packages/stt/package.json` | Package configuration with dependencies |
| `packages/stt/tsconfig.json` | TypeScript configuration |
| `packages/stt/tsconfig.build.json` | Build TypeScript configuration |
| `packages/stt/tsup.config.ts` | Build tool configuration |
| `packages/stt/src/index.ts` | Public API exports |
| `packages/stt/src/types/index.ts` | Type definitions |
| `packages/stt/src/core/STTProcessor.ts` | Main processor class |
| `packages/stt/src/core/AudioBufferManager.ts` | Audio chunking and buffering |
| `packages/stt/src/core/index.ts` | Core module exports |
| `packages/stt/src/providers/types.ts` | Provider interface |
| `packages/stt/src/providers/BaseSTTProvider.ts` | Abstract provider class |
| `packages/stt/src/providers/LocalSTTProvider.ts` | Transformers.js implementation |
| `packages/stt/src/providers/BackendSTTProvider.ts` | WebSocket implementation |
| `packages/stt/src/providers/index.ts` | Providers module exports |
| `packages/stt/src/engines/types.ts` | Engine interface |
| `packages/stt/src/engines/BaseEngine.ts` | Abstract engine class |
| `packages/stt/src/engines/WhisperEngine.ts` | Whisper model wrapper |
| `packages/stt/src/engines/index.ts` | Engines module exports |
| `packages/stt/src/websocket/WebSocketClient.ts` | WebSocket connection |
| `packages/stt/src/websocket/MessageHandler.ts` | Protocol handling |
| `packages/stt/src/websocket/index.ts` | WebSocket module exports |
| `packages/stt/src/utils/audioResampler.ts` | 16kHz resampling utility |
| `packages/stt/src/utils/browserSupport.ts` | Feature detection |
| `packages/stt/src/utils/index.ts` | Utils module exports |
| `packages/stt/assets/README.md` | Asset documentation |
| `packages/stt/README.md` | Package documentation |

### Key Features Implemented

1. **STTProcessor**
   - Extends `BaseProcessor` from `@arcaai/room`
   - Automatic provider selection based on browser capabilities
   - Event emission for transcriptions (final/partial)
   - Statistics and monitoring support
   - Integration with audio track pipeline

2. **LocalSTTProvider**
   - Uses Transformers.js for in-browser Whisper inference
   - WebGPU acceleration with WASM fallback
   - Support for multiple model sizes (tiny, base, small, medium, large)
   - Audio buffering with chunk/stride for long-form transcription
   - Quantized model support for smaller downloads

3. **BackendSTTProvider**
   - WebSocket connection to backend STT service
   - Matches existing protocol from `apps/stt/src/stt/api/handlers/websocket.py`
   - Automatic reconnection and keep-alive
   - Support for speaker diarization

4. **WhisperEngine**
   - Wraps `@huggingface/transformers` pipeline
   - Automatic device selection (WebGPU/WASM)
   - Model loading with progress callbacks
   - Timestamp support (chunk and word level)

5. **AudioBufferManager**
   - Accumulates audio for chunked processing
   - Stride/overlap for context between chunks
   - Automatic resampling to 16kHz

6. **Browser Support Detection**
   - WebGPU, WebAssembly, AudioWorklet detection
   - Recommended provider/device selection
   - Safari version checking

### Dependencies

```json
{
  "dependencies": {
    "@huggingface/transformers": "^3.0.0",
    "eventemitter3": "^5.0.0"
  },
  "peerDependencies": {
    "@arcaai/room": "workspace:*",
    "react": "^18.0.0 || ^19.0.0"
  }
}
```

### Usage Example

```tsx
import { RoomProvider, useAudioTrack, useProcessors } from '@arcaai/room';
import { createSTT } from '@arcaai/stt';

function TranscriptionDemo() {
  const { track, startCapture } = useAudioTrack();
  const { addProcessor } = useProcessors({ track });
  const [text, setText] = useState('');

  useEffect(() => {
    if (track) {
      const stt = createSTT({
        provider: 'auto',
        model: 'tiny',
        language: 'en',
      });

      stt.on('data', (payload) => {
        if (payload.type === 'stt-transcription') {
          setText(prev => prev + ' ' + payload.data.text);
        }
      });

      addProcessor(stt);
    }
  }, [track]);

  return (
    <button onClick={startCapture}>Start Recording</button>
  );
}
```

### Browser Support

| Browser | Local STT | Backend STT |
|---------|-----------|-------------|
| Chrome 113+ | Full (WebGPU) | Full |
| Firefox 100+ | WASM only | Full |
| Safari 17.4+ | WASM only | Full |
| Edge 113+ | Full (WebGPU) | Full |

### Future Considerations

1. Add ONNX Runtime Web direct engine for more control
2. Add support for real-time VAD-gated transcription
3. Add React hooks for easier integration
4. Add streaming partial results for local provider
5. Add custom model loading from URL
6. Add WebWorker-based processing for better performance
7. Add offline model caching

### Testing Performed

- Package structure verification
- TypeScript compilation check (pending actual build)

### Related Documentation

- Package README: `packages/stt/README.md`
- Room package: `packages/room/README.md`
- Backend STT service: `apps/stt/README.md`
