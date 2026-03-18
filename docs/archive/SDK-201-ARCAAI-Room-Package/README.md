# SDK-201: @arcaai/room Package

## Header

| Field        | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| Ticket       | SDK-201                                                     |
| Feature Name | React-based Audio Processing Package                        |
| Created      | 2026-01-09                                                  |
| Last Updated | 2026-01-09                                                  |
| Status       | Completed                                                   |

## Requirement Analysis

### Description

Create a React-based package (`@arcaai/room`) that provides a best-practice audio processing pipeline with:
- On/off configurable audio processing features
- Plugin architecture ready for VAD, transcription, and speaker recognition
- Following LiveKit SDK patterns and best practices

### Business Context

The package serves as the foundation for audio capture and processing in ARCAAI applications, enabling:
- High-quality audio capture from microphones
- Configurable audio enhancement features
- Extensible architecture for future AI-powered audio processing

### Reference Material

- LiveKit Client SDK architecture analysis
- LiveKit Krisp Noise Filter reverse engineering
- `/Users/taphuynh/Desktop/lab/livekit/docs/AUDIO_PROCESSING_ARCHITECTURE.md`
- `/Users/taphuynh/Desktop/lab/livekit/docs/KRISP_NOISE_FILTER_REVERSE_ENGINEERING.md`
- `/Users/taphuynh/Desktop/lab/livekit/docs/KRISP_NOISE_FILTER_COMPLETE_TECHNICAL_ANALYSIS.md`

## Current State Evaluation

This is a new package - no existing implementation to evaluate.

## Implementation Plan

### Architecture

Three-layer audio processing model (based on LiveKit):

1. **Layer 1: WebRTC Native** - Browser-native audio processing via MediaStreamTrack constraints
2. **Layer 2: Track Processors** - Pluggable processors for advanced audio processing
3. **Layer 3: Web Audio API** - AudioContext-based processing for analysis and routing

### Package Structure

```
packages/room/
├── src/
│   ├── index.ts                          # Public API exports
│   ├── core/
│   │   ├── AudioContextManager.ts        # Centralized AudioContext management
│   │   ├── AudioTrack.ts                 # Audio track abstraction
│   │   ├── ProcessorPipeline.ts          # Chain multiple processors
│   │   └── Room.ts                       # Room manager
│   ├── hooks/
│   │   ├── useRoom.ts                    # Room context access
│   │   ├── useAudioTrack.ts              # Audio track management
│   │   ├── useProcessors.ts              # Processor management
│   │   ├── useDevices.ts                 # Device enumeration
│   │   └── useAudioLevel.ts              # Real-time audio level
│   ├── components/
│   │   ├── RoomProvider.tsx              # React context provider
│   │   └── AudioTrackRenderer.tsx        # Audio element management
│   ├── processors/
│   │   ├── types.ts                      # Processor type definitions
│   │   ├── BaseProcessor.ts              # Abstract base processor
│   │   └── NativeProcessor.ts            # WebRTC native processing
│   ├── events/
│   │   ├── TrackEvents.ts                # Track event definitions
│   │   ├── ProcessorEvents.ts            # Processor event definitions
│   │   └── EventEmitter.ts               # Typed event emitter
│   ├── utils/
│   │   ├── audioUtils.ts                 # Audio utilities
│   │   ├── browserSupport.ts             # Browser compatibility
│   │   └── constraints.ts                # MediaStream constraints
│   └── types/
│       └── index.ts                      # TypeScript type definitions
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
└── README.md
```

## Implementation Summary

### Files Created

| File                                      | Purpose                                    |
| ----------------------------------------- | ------------------------------------------ |
| `packages/room/package.json`              | Package configuration                      |
| `packages/room/tsconfig.json`             | TypeScript configuration                   |
| `packages/room/tsconfig.build.json`       | Build-specific TypeScript config           |
| `packages/room/tsup.config.ts`            | Build tool configuration                   |
| `packages/room/src/index.ts`              | Public API exports                         |
| `packages/room/src/types/index.ts`        | Core type definitions                      |
| `packages/room/src/events/TrackEvents.ts` | Track event definitions                    |
| `packages/room/src/events/ProcessorEvents.ts` | Processor event definitions            |
| `packages/room/src/events/EventEmitter.ts` | Typed event emitter                       |
| `packages/room/src/events/index.ts`       | Events module exports                      |
| `packages/room/src/utils/browserSupport.ts` | Browser compatibility utilities          |
| `packages/room/src/utils/constraints.ts`  | MediaStream constraints utilities          |
| `packages/room/src/utils/audioUtils.ts`   | Audio processing utilities                 |
| `packages/room/src/utils/index.ts`        | Utils module exports                       |
| `packages/room/src/core/AudioContextManager.ts` | Centralized AudioContext management  |
| `packages/room/src/core/AudioTrack.ts`    | Audio track abstraction                    |
| `packages/room/src/core/ProcessorPipeline.ts` | Processor chaining                      |
| `packages/room/src/core/Room.ts`          | Room manager                               |
| `packages/room/src/core/index.ts`         | Core module exports                        |
| `packages/room/src/processors/types.ts`   | Processor type definitions                 |
| `packages/room/src/processors/BaseProcessor.ts` | Abstract base processor              |
| `packages/room/src/processors/NativeProcessor.ts` | WebRTC native processor            |
| `packages/room/src/processors/index.ts`   | Processors module exports                  |
| `packages/room/src/components/RoomProvider.tsx` | React context provider              |
| `packages/room/src/components/AudioTrackRenderer.tsx` | Audio element renderer         |
| `packages/room/src/components/index.ts`   | Components module exports                  |
| `packages/room/src/hooks/useRoom.ts`      | Room context hook                          |
| `packages/room/src/hooks/useAudioTrack.ts` | Audio track management hook               |
| `packages/room/src/hooks/useProcessors.ts` | Processor management hook                 |
| `packages/room/src/hooks/useAudioLevel.ts` | Audio level monitoring hook               |
| `packages/room/src/hooks/useDevices.ts`   | Device enumeration hook                    |
| `packages/room/src/hooks/index.ts`        | Hooks module exports                       |
| `packages/room/README.md`                 | Package documentation                      |

### Key Features Implemented

1. **AudioContextManager**
   - Singleton pattern for shared AudioContext
   - iOS Safari suspended state handling
   - Reference counting for proper cleanup

2. **AudioTrack**
   - Audio capture from microphone
   - Processor attachment/detachment
   - Feature toggling (EC, NS, AGC)
   - Audio level monitoring
   - Event emission

3. **ProcessorPipeline**
   - Chain multiple processors
   - Priority-based ordering
   - Enable/disable individual processors

4. **TrackProcessor Interface**
   - Plugin contract for custom processors
   - Lifecycle methods (init, restart, destroy)
   - Event emission support

5. **React Integration**
   - RoomProvider context
   - useRoom, useAudioTrack, useProcessors hooks
   - useAudioLevel, useDevices hooks

6. **Browser Compatibility**
   - Safari version detection
   - AudioWorklet support checking
   - Feature detection utilities

### Plugin Architecture

The package is designed for future plugin packages:

- `@arcaai/vad` - Voice Activity Detection
- `@arcaai/transcription` - Speech-to-text
- `@arcaai/speaker-recognition` - Speaker identification

Plugins implement the `TrackProcessor` interface:

```typescript
interface TrackProcessor {
  readonly name: string;
  processedTrack?: MediaStreamTrack;
  init(opts: AudioProcessorOptions): Promise<void>;
  restart(opts: AudioProcessorOptions): Promise<void>;
  destroy(): Promise<void>;
}
```

### Dependencies

- `eventemitter3` - Event emission
- `react` (peer) - React framework

### Testing Performed

- TypeScript compilation verification
- Package structure validation

### Future Considerations

1. Add unit tests with Vitest
2. Create example applications
3. Implement additional built-in processors
4. Add AudioWorklet-based processing support
5. Create plugin packages (VAD, transcription, speaker recognition)
